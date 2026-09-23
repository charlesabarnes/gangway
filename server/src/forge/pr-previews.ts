import type { Clearance, RepoProject, Preview } from "@gangway/shared/domain";
import { slugify } from "@gangway/shared/hostname";
import { forgeActor, type Actor } from "../auth/actor.ts";
import { AppError } from "../errors.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import type { Logger } from "../logger.ts";
import type { DeployInput, DeployResult, DeploySource, PreviewUrl } from "../previews/deploy.ts";
import type { Policy } from "../previews/policy.ts";
import { commentBody, postComment, refusalBody } from "./pr-comment.ts";
import { finishDeployment, recordDeployment, retireDeployment } from "./pr-deployment.ts";
import type { Association, Forge, ForgeEvent, ForgeRepo, PullRequest } from "./forge.ts";

// <slug>-pr-<n>-<service> has to fit a 63-character DNS label.
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
    forgeRefs(id: string): ForgeRefs;
    setForgeRefs(
      id: string,
      refs: { commentId?: number | null; deploymentId?: number | null },
    ): void;
  };
  secretsFor?: ((repo: RepoProject, clearance: Clearance) => Record<string, string>) | undefined;
  policy: Policy;
  logUrlFor?: ((previewId: string) => string | undefined) | undefined;
  logger: Logger;
  now?: (() => number) | undefined;
};

export type Outcome =
  | { action: "deployed"; previewId: string; name: string; settled: Promise<void> }
  | { action: "destroyed"; previewId: string }
  | { action: "refused"; reason: string }
  | { action: "commented"; previewId: string | null }
  | { action: "ignored"; reason: string };

type CommandEvent = Extract<ForgeEvent, { type: "pr.command" }>;
type ForgeRefs = { commentId: number | null; deploymentId: number | null };
type DeployOptions = { force?: boolean; clearance?: Clearance };

const NO_REFS: ForgeRefs = { commentId: null, deploymentId: null };
const SPEAKS_FOR_REPO: ReadonlySet<Association> = new Set(["owner", "member", "collaborator"]);

export class PrPreviews {
  readonly #d: PrPreviewsDeps;

  constructor(d: PrPreviewsDeps) {
    this.#d = d;
  }

  async handle(event: ForgeEvent): Promise<Outcome> {
    switch (event.type) {
      case "ignored":
        return { action: "ignored", reason: event.reason };
      case "pr.updated":
        return this.#onUpdated(event.pr);
      case "pr.closed":
        return this.#onClosed(event.pr);
      case "pr.command":
        return this.#onCommand(event);
    }
  }

  projectFor(fr: ForgeRepo): RepoProject | string {
    const existing = this.#d.repos.getByFullName(fr.forge, fr.fullName);
    if (!existing)
      return `${fr.fullName} is not a gangway project; create one to preview its pull requests`;
    if (existing.prTrigger !== "webhook")
      return `${fr.fullName} takes pull requests from its workflow, not the GitHub App`;
    if (existing.installationId === fr.installationId) return existing;
    return (
      (this.#d.repos.update(existing.id, { installationId: fr.installationId }) as
        RepoProject | undefined) ?? existing
    );
  }

  previewName(repo: RepoProject, number: number): string {
    return `${repo.slug}-pr-${number}`;
  }

  current(repo: RepoProject, number: number): Preview | undefined {
    return this.#d.previews.findPullRequest(repo.fullName, number);
  }

  async #onUpdated(pr: PullRequest): Promise<Outcome> {
    const repo = this.projectFor(pr.repo);
    if (typeof repo === "string") return { action: "ignored", reason: repo };
    const off = disabled(repo);
    if (off) return off;
    if (pr.draft && !repo.drafts) return { action: "ignored", reason: `#${pr.number} is a draft` };
    if (pr.fromFork) {
      if (repo.forks === "never")
        return {
          action: "ignored",
          reason: `#${pr.number} is from a fork; forks are never previewed for ${repo.fullName}`,
        };
      if (repo.forks === "ask")
        return {
          action: "ignored",
          reason: `#${pr.number} is from a fork; waiting for /preview deploy from someone with a say`,
        };
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

  async #onCommand(ev: CommandEvent): Promise<Outcome> {
    // No reply to anyone else: an error comment is an amplifier.
    if (!SPEAKS_FOR_REPO.has(ev.association))
      return {
        action: "ignored",
        reason: `/preview ${ev.command} from ${ev.author || "someone"} (${ev.association}) on #${ev.number}`,
      };
    const repo = this.projectFor(ev.repo);
    if (typeof repo === "string") return { action: "ignored", reason: repo };
    const actor = forgeActor(ev.repo.forge, ev.author);
    switch (ev.command) {
      case "status":
        return this.#onStatus(ev, repo);
      case "destroy":
        return this.#onDestroy(ev, repo, actor);
      case "secrets":
        return this.#deployOnRequest(ev, repo, actor, { force: true, clearance: ev.level });
      default:
        return this.#deployOnRequest(ev, repo, actor, { force: ev.command === "redeploy" });
    }
  }

  async #onStatus(ev: CommandEvent, repo: RepoProject): Promise<Outcome> {
    const existing = this.current(repo, ev.number);
    const body = existing
      ? commentBody(
          existing,
          this.#d.previews.urls(existing.id),
          "status",
          this.#d.logUrlFor?.(existing.id),
        )
      : "No preview exists for this pull request. Comment `/preview deploy` to build one.";
    await postComment(
      this.#d,
      { repo: ev.repo, number: ev.number },
      existing ? this.#d.previews.forgeRefs(existing.id).commentId : null,
      body,
    );
    return { action: "commented", previewId: existing?.id ?? null };
  }

  async #onDestroy(ev: CommandEvent, repo: RepoProject, actor: Actor): Promise<Outcome> {
    const existing = this.current(repo, ev.number);
    if (!existing) return { action: "ignored", reason: `#${ev.number} has no preview to destroy` };
    const pr = await this.#d.forge.pullRequest(ev.repo, ev.number);
    return this.#destroy(repo, pr, existing, actor, "destroyed on request");
  }

  async #deployOnRequest(
    ev: CommandEvent,
    repo: RepoProject,
    actor: Actor,
    o: DeployOptions,
  ): Promise<Outcome> {
    const off = disabled(repo);
    if (off) return off;
    const pr = await this.#d.forge.pullRequest(ev.repo, ev.number);
    if (pr.fromFork && repo.forks === "never") {
      await postComment(
        this.#d,
        pr,
        this.#refsOf(repo, pr.number).commentId,
        `Pull requests from forks are never previewed for ${repo.fullName}.`,
      );
      return { action: "commented", previewId: null };
    }
    return this.#deploy(repo, pr, actor, o);
  }

  #refsOf(repo: RepoProject, number: number): ForgeRefs {
    const existing = this.current(repo, number);
    return existing ? this.#d.previews.forgeRefs(existing.id) : NO_REFS;
  }

  async #deploy(
    repo: RepoProject,
    pr: PullRequest,
    actor: Actor,
    o: DeployOptions = {},
  ): Promise<Outcome> {
    const name = this.previewName(repo, pr.number);
    const existing = this.current(repo, pr.number);
    const source: DeploySource = {
      kind: "pr",
      repo: pr.repo.fullName,
      number: pr.number,
      sha: pr.headSha,
      cloneUrl: pr.repo.cloneUrl,
      credential: undefined,
    };
    const { template } = this.#d.policy.resolve({ source, actor, projectId: repo.id });
    const clearance: Clearance =
      o.clearance ?? existing?.secretLevel ?? defaultClearance(repo, pr, template.clearance);
    let refs = NO_REFS;
    if (existing) {
      if (isLiveAt(existing, pr.headSha) && !o.force)
        return {
          action: "ignored",
          reason: `#${pr.number} is already ${existing.state} at ${pr.headSha.slice(0, 7)}`,
        };
      refs = this.#d.previews.forgeRefs(existing.id);
      await retireDeployment(this.#d, pr.repo, refs.deploymentId);
      await this.#d.previews.destroy(existing.id, actor);
    }

    const credential = await this.#d.forge.cloneCredential(pr.repo);
    let result: DeployResult;
    try {
      // Given even as {} so the pipeline's by-source lookup does not fill it in.
      const env = clearance === "none" ? {} : (this.#d.secretsFor?.(repo, clearance) ?? {});
      result = await this.#d.previews.deploy({
        actor,
        name,
        env,
        secretLevel: clearance,
        projectId: repo.id,
        ...(pr.fromFork ? { visibility: "public" as const } : {}),
        source: { ...source, credential },
      });
    } catch (e) {
      if (!(e instanceof AppError) || e.status >= 500) throw e;
      await postComment(this.#d, pr, refs.commentId, refusalBody(pr.headSha, e));
      return { action: "refused", reason: e.message };
    }
    return this.#announce(pr, name, refs.commentId, result);
  }

  async #announce(
    pr: PullRequest,
    name: string,
    oldCommentId: number | null,
    result: DeployResult,
  ): Promise<Outcome> {
    const id = result.preview.id;
    const commentId = await postComment(
      this.#d,
      pr,
      oldCommentId,
      commentBody(result.preview, result.urls, "building", this.#d.logUrlFor?.(id)),
    );
    const deploymentId = await recordDeployment(this.#d, pr, name, id);
    this.#d.previews.setForgeRefs(id, { commentId, deploymentId });

    const settled = result.done.then(
      (final) => this.#settle(pr, id, final, { commentId, deploymentId }),
      (e) => {
        this.#d.logger.warn("deploy did not settle", { previewId: id, err: e });
      },
    );
    return { action: "deployed", previewId: id, name, settled };
  }

  async #settle(pr: PullRequest, id: string, final: Preview, refs: ForgeRefs): Promise<void> {
    const urls = this.#d.previews.urls(id);
    const awake = final.state === "awake";
    await postComment(
      this.#d,
      pr,
      refs.commentId,
      commentBody(final, urls, awake ? "ready" : "failed", this.#d.logUrlFor?.(final.id)),
    );
    if (refs.deploymentId !== null)
      await finishDeployment(this.#d, pr, refs.deploymentId, id, { awake, urls });
  }

  async #destroy(
    repo: RepoProject,
    pr: PullRequest,
    existing: Preview,
    actor: Actor,
    why: string,
  ): Promise<Outcome> {
    const refs = this.#d.previews.forgeRefs(existing.id);
    await this.#d.previews.destroy(existing.id, actor);
    await retireDeployment(this.#d, pr.repo, refs.deploymentId);
    await postComment(
      this.#d,
      pr,
      refs.commentId,
      `Preview **${this.previewName(repo, pr.number)}** ${why}; its containers and URLs are gone.`,
    );
    return { action: "destroyed", previewId: existing.id };
  }
}

function disabled(repo: RepoProject): Outcome | undefined {
  if (repo.enabled) return undefined;
  return {
    action: "ignored",
    reason: `${repo.fullName} is disabled: ${repo.disabledReason ?? "by the operator"}`,
  };
}

function defaultClearance(repo: RepoProject, pr: PullRequest, template: Clearance): Clearance {
  return pr.fromFork ? repo.forkClearance : (repo.prClearance ?? template);
}

function isLiveAt(p: Preview, sha: string): boolean {
  const sameHead = p.source.kind === "pr" && p.source.sha === sha;
  return sameHead && (p.state === "building" || p.state === "starting" || p.state === "awake");
}

export function slugFor(repoName: string): string {
  const s = slugify(repoName).slice(0, MAX_REPO_SLUG).replace(/-+$/, "");
  return s === "" ? "repo" : s;
}
