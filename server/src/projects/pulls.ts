/**
 * Pull requests through a workflow (ADR-0014). A GitHub Actions run in the project's
 * repository has built and pushed the head commit's image; it asks for that image to be
 * the PR's preview, and later for the preview to go. The rules, all here:
 *
 *   - a workflow run acts only for the project whose repository its OIDC token names, only
 *     for the pull request its `ref` names, only on a `pull_request` event, and only when
 *     the project takes pull requests by workflow (the webhook would make a second preview);
 *   - one preview per pull request: a new head replaces the old one; the same head, still
 *     live, is left alone -- a re-run is not a redeploy;
 *   - the clearance a pull request was raised or lowered to sticks across pushes (ADR-0012);
 *   - a person or token with the permission may do the same by hand, for any project.
 *
 * Nothing forge-specific happens here: the workflow writes its own PR comment.
 */
import { hasRepo, type Preview, type Project } from "../../../shared/src/domain.ts";
import type { Actor } from "../auth/actor.ts";
import { AppError, conflict, forbidden, notFound } from "../errors.ts";
import type { DeployInput, DeployResult, RegistryLogin } from "../previews/deploy.ts";

export type PullDeployRequest = {
  image: string; port: number; sha: string;
  registry?: { username: string; password: string } | undefined;
};

export type PullsDeps = {
  projects: { find(ref: string): Project | undefined };
  previews: {
    deploy(input: DeployInput): Promise<DeployResult>;
    destroy(id: string, actor: Actor): Promise<Preview>;
    findPullRequest(repo: string, number: number): Preview | undefined;
  };
};

export type PullOutcome =
  | { action: "deployed"; result: DeployResult }
  | { action: "unchanged"; preview: Preview };

const LIVE = new Set(["building", "starting", "awake", "asleep"]);

/** The registry an image reference names: its first segment when that looks like a host. */
export function registryOf(image: string): string {
  const first = image.split("/")[0] ?? "";
  return image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
}

export class Pulls {
  readonly #d: PullsDeps;
  /** One operation per pull request at a time: two pushes in a row must not race each other's teardown. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(d: PullsDeps) { this.#d = d; }

  /** The project, if this actor may act on this pull request of it. */
  authorize(ref: string, number: number, actor: Actor): Project & { fullName: string } {
    const project = this.#d.projects.find(ref);
    if (!project) throw notFound(`no such project: ${ref}`);
    if (!hasRepo(project)) throw new AppError("unprocessable", `project "${project.slug}" has no repository, so it has no pull requests`);
    if (actor.kind === "workflow") {
      if (actor.repository.toLowerCase() !== project.fullName.toLowerCase()) throw forbidden(`this run belongs to ${actor.repository}, not to ${project.fullName}`);
      if (project.prTrigger !== "workflow") throw conflict(`project "${project.slug}" takes pull requests from the GitHub App, not from a workflow; switch it in the project's settings`);
      if (actor.eventName !== "pull_request") throw forbidden(`a workflow may deploy previews from pull_request events only, not ${actor.eventName || "this event"}`);
      if (actor.pull !== number) throw forbidden(`this run is for ${actor.pull === null ? "no pull request" : `#${actor.pull}`}, not #${number}`);
    }
    return project;
  }

  async deploy(ref: string, number: number, req: PullDeployRequest, actor: Actor): Promise<PullOutcome> {
    const project = this.authorize(ref, number, actor);
    if (!project.enabled) throw conflict(`project "${project.slug}" is disabled${project.disabledReason ? `: ${project.disabledReason}` : ""}`);
    return this.#serial(`${project.id}#${number}`, async () => {
      const existing = this.#d.previews.findPullRequest(project.fullName, number);
      if (existing && existing.source.kind === "pr" && existing.source.sha === req.sha && existing.source.image === req.image && LIVE.has(existing.state)) {
        return { action: "unchanged", preview: existing };
      }
      if (existing) await this.#d.previews.destroy(existing.id, actor);
      const registry: RegistryLogin | undefined = req.registry && { server: registryOf(req.image), ...req.registry };
      const result = await this.#d.previews.deploy({
        actor, name: `${project.slug}-pr-${number}`, projectId: project.id,
        // Sticky: a clearance someone set on this PR outlives its pushes (ADR-0012).
        ...(existing?.secretLevel ? { secretLevel: existing.secretLevel } : {}),
        source: { kind: "pushed", image: req.image, port: req.port, pr: { repo: project.fullName, number, sha: req.sha }, registry },
      });
      return { action: "deployed", result };
    });
  }

  /** Idempotent: no preview is not an error -- a closed PR's workflow may run twice. */
  async close(ref: string, number: number, actor: Actor): Promise<Preview | null> {
    const project = this.authorize(ref, number, actor);
    return this.#serial(`${project.id}#${number}`, async () => {
      const existing = this.#d.previews.findPullRequest(project.fullName, number);
      return existing ? this.#d.previews.destroy(existing.id, actor) : null;
    });
  }

  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.#queues.set(key, next);
    void next.finally(() => { if (this.#queues.get(key) === next) this.#queues.delete(key); }).catch(() => {});
    return next;
  }
}
