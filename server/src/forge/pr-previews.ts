/**
 * Pull-request previews (ADR-0011): a `ForgeEvent` in, a preview deployed, redeployed,
 * destroyed or left alone, and the forge told about it. Forge-agnostic: this file knows
 * `Forge`, `Project` and the preview service, and nothing about GitHub.
 *
 * The rules, all of them here:
 *   - only a PROJECT that takes pull requests by webhook is acted for; nothing is made here (ADR-0014);
 *     a taken slug leaves it DISABLED with the reason, for the operator to resolve
 *   - a fork's PR builds only under `repos.forks = auto`, or after `/preview deploy`
 *     from an owner, member or collaborator (§9: public visibility, no secrets)
 *   - a new head is destroy-then-deploy under the same name; the same head already
 *     building or awake is a no-op (webhook redeliveries, `synchronize` storms)
 *   - the forge is told AFTER the preview exists and again when it settles; a forge
 *     call failing never fails the deploy
 */
import type { Clearance, Project, RepoProject } from "../../../shared/src/domain.ts";
import { slugify } from "../../../shared/src/hostname.ts";
import { forgeActor, type Actor } from "../auth/actor.ts";
import { AppError } from "../errors.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import type { Logger } from "../logger.ts";
import type { DeployInput, DeployResult, DeploySource, PreviewUrl } from "../previews/deploy.ts";
import type { Policy } from "../previews/policy.ts";
import type { Preview } from "../../../shared/src/domain.ts";
import { ulid } from "../util/ulid.ts";
import type { Association, Forge, ForgeEvent, ForgeRepo, PullRequest } from "./forge.ts";

/** `<slug>-pr-<n>-<service>` has to fit a 63-character DNS label; this leaves room. */
export const MAX_REPO_SLUG = 24;

export type PrPreviewsDeps = {
  forge: Forge;
  repos: ProjectsRepo;
  instance: string;
  previews: {
    deploy(input: DeployInput): Promise<DeployResult>;
    destroy(id: string, actor: Actor): Promise<Preview>;
    findPullRequest(repo: string, number: number): Preview | undefined;
    urls(id: string): PreviewUrl[];
    forgeRefs(id: string): { commentId: number | null; deploymentId: number | null };
    setForgeRefs(id: string, refs: { commentId?: number | null; deploymentId?: number | null }): void;
  };
  /** The repository's secrets at or below a clearance (ADR-0012). */
  secretsFor?: ((repo: RepoProject, clearance: Clearance) => Record<string, string>) | undefined;
  /** The template a pull request follows (ADR-0013): its clearance is the fallback when the repository has no override. */
  policy: Policy;
  /** Where a human reads the build log: the UI's preview page, when the UI is on. */
  logUrlFor?: ((previewId: string) => string | undefined) | undefined;
  logger: Logger;
  now?: (() => number) | undefined;
};

export type Outcome =
  | { action: "deployed"; previewId: string; name: string; settled: Promise<void> }
  | { action: "destroyed"; previewId: string }
  /** The plan refused the source (a bad compose file, the policy) -- said on the PR, nothing deployed. */
  | { action: "refused"; reason: string }
  | { action: "commented"; previewId: string | null }
  | { action: "ignored"; reason: string };

const SPEAKS_FOR_REPO: ReadonlySet<Association> = new Set(["owner", "member", "collaborator"]);

export class PrPreviews {
  readonly #d: PrPreviewsDeps;

  constructor(d: PrPreviewsDeps) {
    this.#d = d;
  }

  async handle(event: ForgeEvent): Promise<Outcome> {
    switch (event.type) {
      case "ignored": return { action: "ignored", reason: event.reason };
      case "pr.updated": return this.#onUpdated(event.pr);
      case "pr.closed": return this.#onClosed(event.pr);
      case "pr.command": return this.#onCommand(event);
    }
  }

  /* ---------------------------------------------------------------- repositories */

  /**
   * The project for a repository, or why there is none to act for (ADR-0014). Nothing is
   * made here: a project is made on purpose, and one that takes pull requests from its
   * own workflow must not get a second preview from the webhook.
   */
  projectFor(fr: ForgeRepo): RepoProject | string {
    const existing = this.#d.repos.getByFullName(fr.forge, fr.fullName);
    if (!existing) return `${fr.fullName} is not a gangway project; create one to preview its pull requests`;
    if (existing.prTrigger !== "webhook") return `${fr.fullName} takes pull requests from its workflow, not the GitHub App`;
    if (existing.installationId === fr.installationId) return existing;
    return (this.#d.repos.update(existing.id, { installationId: fr.installationId }) as RepoProject | undefined) ?? existing;
  }

  previewName(repo: RepoProject, number: number): string { return `${repo.slug}-pr-${number}`; }

  /** By source, not by name: an unlisted preview's name carries a suffix that changes per deploy. */
  current(repo: RepoProject, number: number): Preview | undefined {
    return this.#d.previews.findPullRequest(repo.fullName, number);
  }

  /* ---------------------------------------------------------------- events */

  async #onUpdated(pr: PullRequest): Promise<Outcome> {
    const repo = this.projectFor(pr.repo);
    if (typeof repo === "string") return { action: "ignored", reason: repo };
    if (!repo.enabled) return { action: "ignored", reason: `${repo.fullName} is disabled: ${repo.disabledReason ?? "by the operator"}` };
    if (pr.draft && !repo.drafts) return { action: "ignored", reason: `#${pr.number} is a draft` };
    if (pr.fromFork) {
      if (repo.forks === "never") return { action: "ignored", reason: `#${pr.number} is from a fork; forks are never previewed for ${repo.fullName}` };
      if (repo.forks === "ask") return { action: "ignored", reason: `#${pr.number} is from a fork; waiting for /preview deploy from someone with a say` };
    }
    return this.#deploy(repo, pr, forgeActor(pr.repo.forge, pr.author));
  }

  async #onClosed(pr: PullRequest): Promise<Outcome> {
    const repo = this.projectFor(pr.repo);
    if (typeof repo === "string") return { action: "ignored", reason: repo };
    const existing = this.current(repo, pr.number);
    if (!existing) return { action: "ignored", reason: `#${pr.number} has no preview` };
    return this.#destroy(repo, pr, existing, forgeActor(pr.repo.forge, pr.author), "closed");
  }

  async #onCommand(ev: Extract<ForgeEvent, { type: "pr.command" }>): Promise<Outcome> {
    // Anyone else is answered with nothing: an error comment is an amplifier (ADR-0011).
    if (!SPEAKS_FOR_REPO.has(ev.association)) return { action: "ignored", reason: `/preview ${ev.command} from ${ev.author || "someone"} (${ev.association}) on #${ev.number}` };
    const repo = this.projectFor(ev.repo);
    if (typeof repo === "string") return { action: "ignored", reason: repo };
    const actor = forgeActor(ev.repo.forge, ev.author);

    if (ev.command === "status") {
      const existing = this.current(repo, ev.number);
      const body = existing ? this.#body(existing, this.#d.previews.urls(existing.id), "status") : "No preview exists for this pull request. Comment `/preview deploy` to build one.";
      await this.#say({ repo: ev.repo, number: ev.number }, existing ? this.#d.previews.forgeRefs(existing.id).commentId : null, body);
      return { action: "commented", previewId: existing?.id ?? null };
    }
    if (ev.command === "secrets") {
      // Raise or lower THIS pull request's clearance: a redeploy at that level, and it sticks.
      if (!repo.enabled) return { action: "ignored", reason: `${repo.fullName} is disabled: ${repo.disabledReason ?? "by the operator"}` };
      const pr = await this.#d.forge.pullRequest(ev.repo, ev.number);
      if (pr.fromFork && repo.forks === "never") {
        await this.#say(pr, this.#refsOf(repo, pr.number).commentId, `Pull requests from forks are never previewed for ${repo.fullName}.`);
        return { action: "commented", previewId: null };
      }
      return this.#deploy(repo, pr, actor, { force: true, clearance: ev.level });
    }
    if (ev.command === "destroy") {
      const existing = this.current(repo, ev.number);
      if (!existing) return { action: "ignored", reason: `#${ev.number} has no preview to destroy` };
      const pr = await this.#d.forge.pullRequest(ev.repo, ev.number);
      return this.#destroy(repo, pr, existing, actor, "destroyed on request");
    }
    // deploy | redeploy
    if (!repo.enabled) return { action: "ignored", reason: `${repo.fullName} is disabled: ${repo.disabledReason ?? "by the operator"}` };
    const pr = await this.#d.forge.pullRequest(ev.repo, ev.number);
    if (pr.fromFork && repo.forks === "never") {
      const existing = this.current(repo, pr.number);
      await this.#say(pr, existing ? this.#d.previews.forgeRefs(existing.id).commentId : null, `Pull requests from forks are never previewed for ${repo.fullName}.`);
      return { action: "commented", previewId: null };
    }
    return this.#deploy(repo, pr, actor, { force: ev.command === "redeploy" });
  }

  /* ---------------------------------------------------------------- the two moves */

  #refsOf(repo: RepoProject, number: number): { commentId: number | null; deploymentId: number | null } {
    const existing = this.current(repo, number);
    return existing ? this.#d.previews.forgeRefs(existing.id) : { commentId: null, deploymentId: null };
  }

  async #deploy(repo: RepoProject, pr: PullRequest, actor: Actor, o: { force?: boolean; clearance?: Clearance } = {}): Promise<Outcome> {
    const name = this.previewName(repo, pr.number);
    const existing = this.current(repo, pr.number);
    let refs = { commentId: null as number | null, deploymentId: null as number | null };
    const source: DeploySource = { kind: "pr", repo: pr.repo.fullName, number: pr.number, sha: pr.headSha, cloneUrl: pr.repo.cloneUrl, credential: undefined };
    // The clearance: asked for now, else what this PR already had, else the repository's
    // policy -- a fork's clearance, or the override on top of the template's.
    const { template } = this.#d.policy.resolve({ source, actor, projectId: repo.id });
    const clearance: Clearance = o.clearance ?? existing?.secretLevel ?? (pr.fromFork ? repo.forkClearance : repo.prClearance ?? template.clearance);
    if (existing) {
      const sameHead = existing.source.kind === "pr" && existing.source.sha === pr.headSha;
      const live = existing.state === "building" || existing.state === "starting" || existing.state === "awake";
      if (sameHead && live && !o.force) return { action: "ignored", reason: `#${pr.number} is already ${existing.state} at ${pr.headSha.slice(0, 7)}` };
      // The comment outlives the preview it was made for: the thread stays one comment.
      refs = this.#d.previews.forgeRefs(existing.id);
      await this.#retireDeployment(pr.repo, refs.deploymentId);
      await this.#d.previews.destroy(existing.id, actor);
    }

    // Minted for public repositories too: one code path, and authenticated fetches are not rate-limited like anonymous ones.
    const credential = await this.#d.forge.cloneCredential(pr.repo);
    // §9: a fork is public, whatever the repository or template says. Everything else --
    // the repository's overrides, the template -- the pipeline resolves from the source.
    let result: DeployResult;
    try {
      // Given explicitly, even as {}: the pipeline's by-source lookup must not fill it in.
      const env = clearance === "none" ? {} : (this.#d.secretsFor?.(repo, clearance) ?? {});
      result = await this.#d.previews.deploy({
        actor, name, env, secretLevel: clearance, projectId: repo.id, ...(pr.fromFork ? { visibility: "public" as const } : {}),
        source: { ...source, credential },
      });
    } catch (e) {
      // Refused before a preview existed: no row, no deployment, and -- unless said here --
      // no word to the author. Found on tower: a policy refusal was silence on the PR.
      if (!(e instanceof AppError) || e.status >= 500) throw e;
      const why = this.#refusal(e);
      await this.#say(pr, refs.commentId, `### ❌ Preview refused for \`${pr.headSha.slice(0, 7)}\`\n\n${why}\n\n\`/preview redeploy\` after a fix.`);
      return { action: "refused", reason: e.message };
    }
    const id = result.preview.id;

    // Tell the forge. Failures are logged and do not touch the preview.
    const commentId = await this.#say(pr, refs.commentId, this.#body(result.preview, result.urls, "building"));
    let deploymentId: number | null = null;
    try {
      deploymentId = await this.#d.forge.createDeployment(pr, `preview/${name}`);
      await this.#d.forge.setDeploymentStatus(pr.repo, deploymentId, "in_progress", this.#logUrl(id));
    } catch (e) {
      this.#d.logger.warn("forge deployment not recorded", { previewId: id, err: e });
    }
    this.#d.previews.setForgeRefs(id, { commentId, deploymentId });

    const settled = result.done.then(async (final) => {
      const urls = this.#d.previews.urls(id);
      await this.#say(pr, commentId, this.#body(final, urls, final.state === "awake" ? "ready" : "failed"));
      if (deploymentId !== null) {
        try {
          const primary = urls.find((u) => u.primary)?.url;
          await this.#d.forge.setDeploymentStatus(pr.repo, deploymentId, final.state === "awake" ? "success" : "failure",
            { ...(primary ? { environmentUrl: primary } : {}), ...this.#logUrl(id) });
        } catch (e) {
          this.#d.logger.warn("forge deployment status not set", { previewId: id, err: e });
        }
      }
    }, (e) => { this.#d.logger.warn("deploy did not settle", { previewId: id, err: e }); });
    return { action: "deployed", previewId: id, name, settled };
  }

  async #destroy(repo: RepoProject, pr: PullRequest, existing: Preview, actor: Actor, why: string): Promise<Outcome> {
    const refs = this.#d.previews.forgeRefs(existing.id);
    await this.#d.previews.destroy(existing.id, actor);
    await this.#retireDeployment(pr.repo, refs.deploymentId);
    await this.#say(pr, refs.commentId, `Preview **${this.previewName(repo, pr.number)}** ${why}; its containers and URLs are gone.`);
    return { action: "destroyed", previewId: existing.id };
  }

  /* ---------------------------------------------------------------- forge helpers */

  async #say(pr: Pick<PullRequest, "repo" | "number">, existingId: number | null, body: string): Promise<number | null> {
    try {
      return await this.#d.forge.upsertComment(pr, existingId, body);
    } catch (e) {
      this.#d.logger.warn("forge comment not written", { repo: pr.repo.fullName, number: pr.number, err: e });
      return existingId;
    }
  }

  async #retireDeployment(repo: ForgeRepo, deploymentId: number | null): Promise<void> {
    if (deploymentId === null) return;
    try {
      await this.#d.forge.setDeploymentStatus(repo, deploymentId, "inactive");
    } catch (e) {
      this.#d.logger.warn("forge deployment not retired", { repo: repo.fullName, deploymentId, err: e });
    }
  }

  /** The message, and the part of the detail a human can act on (compose's stderr, a policy note). */
  #refusal(e: AppError): string {
    const d = e.detail ?? {};
    const text = [d["compose"], d["reason"], d["message"]].find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
    // Compose warns about every unset `${VAR}` before saying what is wrong; the warnings are not it.
    const shown = text?.split(/\r?\n/).filter((l) => !/^time="[^"]*" level=warning /.test(l)).join("\n").trim();
    return shown ? `${e.message}\n\n\`\`\`\n${shown.slice(-1500)}\n\`\`\`` : e.message;
  }

  #logUrl(previewId: string): { logUrl?: string } {
    const u = this.#d.logUrlFor?.(previewId);
    return u ? { logUrl: u } : {};
  }

  #body(p: Preview, urls: PreviewUrl[], phase: "building" | "ready" | "failed" | "status"): string {
    const sha = p.source.kind === "pr" ? p.source.sha.slice(0, 7) : "";
    const primary = urls.find((u) => u.primary) ?? urls[0];
    const lines: string[] = [];
    const state = phase === "status" ? p.state : phase;
    const title = { building: "🚧 Building preview", ready: "✅ Preview ready", failed: "❌ Preview failed", status: `Preview is **${p.state}**` }[phase];
    lines.push(`### ${title}${sha ? ` for \`${sha}\`` : ""}`);
    if (p.secretLevel) lines.push("", `_Secrets: **${p.secretLevel}**${p.secretLevel === "none" ? " (no .env)" : ""} · \`/preview secrets low|standard|high|none\` to change._`);
    if (primary && state !== "failed") lines.push("", `**${primary.url}**`);
    if (urls.length > 1) lines.push("", ...urls.map((u) => `- \`${u.service}\`: ${u.url}`));
    if (p.state === "failed" && p.error) lines.push("", "```", p.error.slice(0, 2000), "```");
    const log = this.#d.logUrlFor?.(p.id);
    lines.push("", `${log ? `[Build log](${log}) · ` : ""}\`/preview redeploy\` · \`/preview destroy\` · \`/preview status\``);
    if (p.ttlExpiresAt) lines.push("", `_Expires ${p.ttlExpiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC unless visited._`);
    return lines.join("\n");
  }
}

/** The default hostname stem for a repository: its name, slugified, at most MAX_REPO_SLUG. */
export function slugFor(repoName: string): string {
  const s = slugify(repoName).slice(0, MAX_REPO_SLUG).replace(/-+$/, "");
  return s === "" ? "repo" : s;
}
