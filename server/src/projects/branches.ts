import { hasRepo, type BranchRef, type Preview, type Project } from "@gangway/shared/domain";
import type { Actor } from "../auth/actor.ts";
import type { AuditSink } from "../audit/audit.ts";
import { AppError, conflict, forbidden, notFound } from "../errors.ts";
import type { DeployInput, DeployResult } from "../previews/deploy-types.ts";
import type { RedeployInput } from "../previews/redeploy-input.ts";
import type { RedeployResult } from "../previews/redeploy.ts";
import type { TarballSource } from "../previews/source/tarball.ts";

export type BranchDeployRequest = {
  archive: TarballSource;
  sha: string;
  port?: number | undefined;
};

export type BranchesDeps = {
  projects: {
    find(ref: string): Project | undefined;
    update(id: string, patch: { productionPreviewId: string | null }): Project | undefined;
  };
  previews: {
    get(id: string): Preview | undefined;
    /** A project's live previews, newest first. */
    list(f: { projectId: string }): Preview[];
    deploy(input: DeployInput): Promise<DeployResult>;
    redeploy(input: RedeployInput): Promise<RedeployResult>;
    destroy(id: string, actor: Actor): Promise<Preview>;
    sealedSecrets?(id: string): string | null;
  };
  audit: AuditSink;
  labelFor(project: Project): string;
  relabel(previewId: string, label: string): void;
  refreshDomains(): void;
};

/** The final state, and whether this commit is what serves: a failed rebuild keeps the last one. */
export type BranchSettled = { preview: Preview; ok: boolean };

export type BranchOutcome =
  | { action: "deployed"; preview: Preview; done: Promise<BranchSettled> }
  | { action: "unchanged"; preview: Preview };

type BranchProject = Project & { fullName: string; deployBranch: string };
type Push = { project: BranchProject; req: BranchDeployRequest; commit: BranchRef; actor: Actor };

const LIVE = new Set(["building", "starting", "awake", "asleep"]);
const REBUILDABLE = new Set(["awake", "asleep"]);

export class Branches {
  readonly #d: BranchesDeps;
  // One deploy per project at a time, held until it settles: the next push waits its turn.
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(d: BranchesDeps) {
    this.#d = d;
  }

  authorize(ref: string, actor: Actor): BranchProject {
    const project = this.#d.projects.find(ref);
    if (!project) {
      throw notFound(`no such project: ${ref}`);
    }
    if (!hasRepo(project)) {
      throw new AppError(
        "unprocessable",
        `project "${project.slug}" has no repository, so it has no branch to deploy`,
      );
    }
    const branch = project.deployBranch;
    if (branch === null) {
      throw conflict(
        `project "${project.slug}" has no deploy branch; choose one in the project's settings`,
      );
    }
    if (actor.kind === "workflow") {
      if (actor.repository.toLowerCase() !== project.fullName.toLowerCase()) {
        throw forbidden(`this run belongs to ${actor.repository}, not to ${project.fullName}`);
      }
      if (actor.eventName !== "push") {
        throw forbidden(
          `a workflow may deploy a branch from push events only, not ${actor.eventName || "this event"}`,
        );
      }
      if (actor.ref !== `refs/heads/${branch}`) {
        throw forbidden(`this run is for ${actor.ref || "no ref"}, not refs/heads/${branch}`);
      }
    }
    return { ...project, deployBranch: branch };
  }

  async deploy(ref: string, req: BranchDeployRequest, actor: Actor): Promise<BranchOutcome> {
    const { id } = this.#ready(ref, actor);
    // Checked again once its turn comes: the project may have changed while it waited.
    return this.#serial(id, async () => {
      const project = this.#ready(id, actor);
      const commit: BranchRef = {
        repo: project.fullName,
        branch: project.deployBranch,
        sha: req.sha,
      };
      const push: Push = { project, req, commit, actor };
      const { target, production } = this.#target(project.id, commit);
      const was = target?.source.kind === "tarball" ? target.source.branch : undefined;
      if (
        target &&
        was?.sha === commit.sha &&
        was.branch === commit.branch &&
        LIVE.has(target.state)
      ) {
        return { action: "unchanged", preview: target };
      }
      // Production that failed to roll back still keeps its source; a first deploy may not.
      if (target && (REBUILDABLE.has(target.state) || (production && target.state === "failed"))) {
        return this.#rebuild(push, target);
      }
      return this.#fresh(push, target);
    });
  }

  #ready(ref: string, actor: Actor): BranchProject {
    const project = this.authorize(ref, actor);
    if (!project.enabled) {
      const reason = project.disabledReason ? `: ${project.disabledReason}` : "";
      throw conflict(`project "${project.slug}" is disabled${reason}`);
    }
    return project;
  }

  /** The preview a push rebuilds: production, else the last branch deploy, not yet or no longer it. */
  #target(
    projectId: string,
    commit: BranchRef,
  ): { target: Preview | undefined; production: boolean } {
    const current = this.#d.projects.find(projectId);
    const prodId = current?.productionPreviewId ?? null;
    const prod = prodId === null ? undefined : this.#d.previews.get(prodId);
    if (!prod) {
      const last = this.#d.previews
        .list({ projectId })
        .find((p) => p.source.kind === "tarball" && p.source.branch);
      return { target: last, production: false };
    }
    const built = prod.source.kind === "tarball" ? prod.source.branch : undefined;
    if (!built) {
      throw conflict(
        `project "${current?.slug ?? projectId}"'s production is preview ${prod.id}, chosen by hand; choose none, and the next push becomes production`,
      );
    }
    if (built.repo.toLowerCase() !== commit.repo.toLowerCase() || built.branch !== commit.branch) {
      throw conflict(
        `project "${current?.slug ?? projectId}"'s production is preview ${prod.id}, built from ${built.repo}@${built.branch}; choose none, and the next push rebuilds it from ${commit.branch}`,
      );
    }
    return { target: prod, production: true };
  }

  async #rebuild({ project, req, commit, actor }: Push, target: Preview): Promise<BranchOutcome> {
    const res = await this.#d.previews.redeploy({
      actor: rebuilder(actor),
      previewId: target.id,
      change: { kind: "replace", archive: req.archive },
      branch: commit,
    });
    const done = res.done.then((o) => {
      const ok = o.outcome === "succeeded";
      if (ok) {
        this.#promote(project.id, commit.branch, { previewId: o.preview.id, actor });
      }
      return { preview: o.preview, ok };
    });
    return { action: "deployed", preview: res.preview, done };
  }

  async #fresh(
    { project, req, commit, actor }: Push,
    stale: Preview | undefined,
  ): Promise<BranchOutcome> {
    // Its secrets outlive it: read them before it goes.
    const carrySecrets = stale ? (this.#d.previews.sealedSecrets?.(stale.id) ?? null) : null;
    if (stale) {
      await this.#d.previews.destroy(stale.id, actor);
    }
    const result = await this.#d.previews.deploy({
      actor,
      name: this.#d.labelFor(project),
      fixedName: true,
      projectId: project.id,
      ttl: null,
      ...(stale?.secretLevel ? { secretLevel: stale.secretLevel } : {}),
      carrySecrets,
      source: {
        kind: "tarball",
        archive: req.archive,
        port: req.port,
        runtime: "auto",
        branch: commit,
      },
    });
    const done = result.done.then((p) => {
      const ok = p.state === "awake";
      if (ok) {
        this.#promote(project.id, commit.branch, { previewId: p.id, actor });
      }
      return { preview: p, ok };
    });
    return { action: "deployed", preview: result.preview, done };
  }

  /** A branch deploy that serves becomes production, unless that changed while it built. */
  #promote(
    projectId: string,
    branch: string,
    { previewId, actor }: { previewId: string; actor: Actor },
  ): void {
    const project = this.#d.projects.find(projectId);
    if (project?.productionPreviewId !== null || project.deployBranch !== branch) {
      return;
    }
    // The address may have changed while it built; a name taken meanwhile keeps the one it has.
    try {
      this.#d.relabel(previewId, this.#d.labelFor(project));
    } catch {
      // Renamed later from the project's settings.
    }
    if (this.#d.previews.get(previewId)?.state !== "awake") {
      return;
    }
    this.#d.projects.update(project.id, { productionPreviewId: previewId });
    this.#d.audit.record(actor, "project.production", project.id, { old: null, new: previewId });
    this.#d.refreshDomains();
  }

  #serial(key: string, fn: () => Promise<BranchOutcome>): Promise<BranchOutcome> {
    const prev = this.#queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const held = next.then((o) => (o.action === "deployed" ? o.done : undefined));
    this.#queues.set(key, held);
    void held
      .finally(() => {
        if (this.#queues.get(key) === held) {
          this.#queues.delete(key);
        }
      })
      .catch(() => {});
    return next;
  }
}

// A push run is authorized for this one preview above; rebuilding needs "previews.update",
// which a workflow's token does not carry for any other preview.
function rebuilder(actor: Actor): Actor {
  if (actor.kind !== "workflow") {
    return actor;
  }
  return { ...actor, permissions: new Set([...actor.permissions, "previews.update"]) };
}
