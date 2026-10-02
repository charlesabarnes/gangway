import { must } from "@gangway/shared/must";
import type { AppPlan } from "@gangway/shared/app-plan";
import { servedByGangway, type Host, type Preview } from "@gangway/shared/domain";
import { actorId, mayRebuild } from "../auth/actor.ts";
import { psArgv, upArgv } from "../docker/compose.ts";
import { AppError, conflict, forbidden, notFound, errorMessage } from "../errors.ts";
import { ulid } from "../util/ulid.ts";
import type { PlannedRoute } from "./planned-route.ts";
import { checkContainerAllowed } from "./container-access.ts";
import type { BuildingContext, PreviewContext, StaticContext } from "./context.ts";
import {
  buildImages,
  failureMessage,
  openPipeline,
  runJob,
  startStack,
  waitTargetFor,
  type Pipeline,
} from "./pipeline.ts";
import { dropPrevious, keepPrevious } from "./previous-images.ts";
import {
  keepDraft,
  outcomeOf,
  rebuildFailed,
  scopeOf,
  type Failure,
  type RebuildRun,
  type RedeployOutcome,
} from "./rebuild-failure.ts";
import { planRebuild, type Rebuild, type RebuildPlan } from "./rebuild-plan.ts";
import type { RedeployInput } from "./redeploy-input.ts";
import { releaseStack } from "./destroy.ts";
import { imageIds, removeReplaced } from "./replaced-images.ts";
import { markServing, withheldLine } from "./site.ts";
import type { SourceStore } from "./source/store.ts";
import { dropProjectNetwork, writeStack } from "./stack-file.ts";
import { releaseFor } from "./steps.ts";
import { waitAnswering, waitHealthy } from "./wait.ts";

export { checkEditPath, type SourceEdits } from "./source-edits.ts";
export type { RedeployOutcome } from "./rebuild-failure.ts";

export type RedeployResult = {
  preview: Preview;
  buildId: string;
  done: Promise<RedeployOutcome>;
  plan?: AppPlan | undefined;
};

const REBUILD_REFUSAL =
  'this preview was deployed by someone else: "previews.update_own" covers only your own, and rebuilding any preview needs "previews.update" (the `update` scope for a token or an agent)';

const routesOf = (ctx: Pick<PreviewContext, "table">, previewId: string): PlannedRoute[] =>
  ctx.table.forPreview(previewId).map((e) => ({
    hostname: e.hostname,
    previewId: e.previewId,
    service: e.service,
    containerPort: e.containerPort,
    upstream: { host: e.upstreamHost, port: e.upstreamPort },
    primary: e.primary,
  }));

/** A domain chosen since the last build takes effect now, before the stack sees its URLs. */
function moveToChosenDomain(
  ctx: Pick<PreviewContext, "domains" | "table" | "logs">,
  preview: Preview,
): void {
  if (!ctx.domains) {
    return;
  }
  const moves = ctx.table.moveToDomain(preview.id, ctx.domains.domainOf(preview));
  for (const [from, to] of moves) {
    ctx.logs.append(preview.id, "system", `moving ${from} to ${to}`);
  }
}

async function checkRebuildable(
  ctx: Pick<PreviewContext, "previews" | "sources" | "hosts">,
  input: RedeployInput,
): Promise<{ host: Host; sources: SourceStore }> {
  const id = input.previewId;
  const current = ctx.previews.get(id);
  if (!current || current.state === "destroyed") {
    throw notFound(`no such preview: ${id}`);
  }
  if (!mayRebuild(input.actor, ctx.previews.provenanceOf(id))) {
    throw forbidden(REBUILD_REFUSAL);
  }
  checkContainerAllowed(input.actor, "rebuilding this preview", !servedByGangway(current));
  if (current.source.kind !== "tarball" || !ctx.sources || !(await ctx.sources.has(id))) {
    throw conflict(
      "only an uploaded preview can be rebuilt from a new source; this one keeps none",
    );
  }
  const host = ctx.hosts.get(current.hostId);
  if (!host) {
    throw new AppError("internal", `preview ${id} is on unknown host ${current.hostId}`);
  }
  return { host, sources: ctx.sources };
}

type Claimed = {
  preview: Preview;
  abort: AbortController;
  done: Promise<RedeployOutcome>;
  settle: (o: RedeployOutcome) => void;
};

// No await from these checks until the inflight claim, so two saves can't both get past.
function claimRebuild(
  ctx: Pick<PreviewContext, "previews" | "inflight" | "teardowns">,
  id: string,
): Claimed {
  const preview = ctx.previews.get(id);
  if (!preview) {
    throw notFound(`no such preview: ${id}`);
  }
  if (!["awake", "asleep", "failed"].includes(preview.state)) {
    throw conflict(`the preview is ${preview.state}; wait for it to settle`, {
      state: preview.state,
    });
  }
  if (ctx.inflight.has(id) || ctx.teardowns.has(id)) {
    throw conflict("a deploy of this preview is still running");
  }
  const abort = new AbortController();
  let settle!: (o: RedeployOutcome) => void;
  const done = new Promise<RedeployOutcome>((r) => {
    settle = r;
  });
  ctx.inflight.set(id, { abort, done: done.then((o) => o.preview) });
  return { preview, abort, done, settle };
}

function announce(
  ctx: Pick<PreviewContext, "bus" | "audit">,
  b: Rebuild,
  plan: RebuildPlan,
  buildId: string,
): void {
  const id = b.preview.id;
  ctx.bus.publish(
    "preview.redeploy",
    { phase: "started", buildId, by: actorId(b.input.actor) },
    id,
  );
  ctx.audit.record(b.input.actor, "preview.redeploy", id, {
    new: {
      project: b.preview.project,
      change: b.input.change.kind,
      runtime: plan.next.runtime ?? "own",
      buildId,
    },
  });
}

export async function redeploy(ctx: PreviewContext, input: RedeployInput): Promise<RedeployResult> {
  const id = input.previewId;
  const { host, sources } = await checkRebuildable(ctx, input);
  const { preview, abort, done, settle } = claimRebuild(ctx, id);

  const buildId = ulid(ctx.now());
  const wd = await ctx.workdirs.create(buildId).catch((e) => {
    ctx.inflight.delete(id);
    throw e;
  });
  try {
    moveToChosenDomain(ctx, preview);
  } catch (e) {
    await wd.cleanup();
    ctx.inflight.delete(id);
    settle({ preview, buildId, outcome: "failed", error: errorMessage(e) });
    throw conflict(errorMessage(e));
  }
  const b: Rebuild = { input, sources, preview, host, wd, routes: routesOf(ctx, id) };
  let plan: RebuildPlan;
  try {
    plan = await planRebuild(ctx, b);
    checkContainerAllowed(input.actor, "the new source", plan.site === null);
  } catch (e) {
    await wd.cleanup();
    ctx.inflight.delete(id);
    settle({
      preview: ctx.previews.get(id) ?? preview,
      buildId,
      outcome: "failed",
      error: errorMessage(e),
    });
    throw e;
  }

  announce(ctx, b, plan, buildId);
  const r: RebuildRun = {
    preview,
    host,
    wd,
    routes: b.routes,
    visibility: preview.visibility,
    buildId,
    signal: abort.signal,
    ...plan.planned,
    source: plan.next,
    addonServices: plan.addonServices,
    rebuild: b,
    keep: plan.keep,
  };
  void (plan.site ? runSite(ctx, r, plan.site) : run(ctx, r))
    .then(
      (o) => {
        settle(o);
      },
      (e: unknown) => {
        settle({
          preview: ctx.previews.get(id) ?? preview,
          buildId,
          outcome: "failed",
          error: String(e),
        });
      },
    )
    .finally(() => {
      ctx.inflight.delete(id);
    });

  return { preview: ctx.previews.get(id) ?? preview, buildId, done, plan: plan.app };
}

async function startAddons(ctx: BuildingContext, p: Pipeline, r: RebuildRun): Promise<void> {
  if (r.addonServices.length === 0) {
    return;
  }
  await p.step(
    "up (add-ons)",
    upArgv(p.base, ["--no-build", "--no-deps", ...r.addonServices]),
    "stdout",
  );
  await waitHealthy(ctx, {
    previewId: p.id,
    host: r.host,
    routes: [],
    signal: r.signal,
    ps: psArgv(p.base, ["--all", ...r.addonServices]),
    cwd: r.wd.srcDir,
  });
}

async function runSite(
  ctx: StaticContext & BuildingContext & Pick<PreviewContext, "table" | "bus">,
  r: RebuildRun,
  plan: AppPlan,
): Promise<RedeployOutcome> {
  const id = r.preview.id;
  const was = ctx.previews.get(id) ?? r.preview;
  const moving = !servedByGangway(was);
  try {
    const { files, withheld } = await must(ctx.sites, "the site store").publish(
      id,
      r.wd.srcDir,
      plan,
    );
    r.signal.throwIfAborted();
    await r.keep("deployed", moving ? { serve: "gangway" } : {});
    ctx.table.setSite(id, true);
    markServing(ctx, id);
    const left = withheldLine(withheld);
    if (left) {
      ctx.logs.append(id, "system", left);
    }
    ctx.logs.append(id, "system", `rebuilt: serving ${files} files from gangway`);
    if (moving) {
      const removed = await releaseStack(ctx, was, r.host);
      ctx.logs.append(
        id,
        "system",
        removed
          ? "removed the old container: gangway serves the files now"
          : "could not remove the old container; the reconciler stops it",
      );
    }
    return outcomeOf(ctx, r, "succeeded");
  } catch (e) {
    if (r.signal.aborted) {
      return {
        preview: ctx.previews.get(id) ?? r.preview,
        buildId: r.buildId,
        outcome: "failed",
        error: "cancelled",
      };
    }
    const message = failureMessage(ctx, id, e, "site rebuild error");
    await keepDraft(ctx, r);
    ctx.logs.append(
      id,
      "system",
      `rebuild FAILED: ${message} -- the previous version is still serving`,
    );
    return outcomeOf(ctx, r, "failed", message);
  } finally {
    await r.wd.cleanup();
  }
}

/** The new version serves: failing to store its source must not roll it back. */
async function keepDeployed(ctx: Pick<PreviewContext, "logger">, r: RebuildRun): Promise<void> {
  try {
    await r.keep("deployed");
  } catch (e) {
    ctx.logger.error("could not keep a rebuilt preview's source", {
      previewId: r.preview.id,
      err: e,
    });
  }
}

async function run(ctx: PreviewContext, r: RebuildRun): Promise<RedeployOutcome> {
  const p = openPipeline(ctx, r);
  if (ctx.previews.get(p.id)?.state === "failed") {
    ctx.states.transition(p.id, "building");
  }

  const f: Failure = { e: null, upAttempted: false, released: false, previous: [] };
  try {
    const shared = await writeStack(ctx, p.stackPath, r);
    const images = { host: r.host, base: p.base, cwd: r.wd.srcDir };
    const before = await imageIds(ctx, images);
    f.previous = await keepPrevious(ctx, scopeOf(p, r));
    await buildImages(ctx, p, r, r.buildId);
    await startAddons(ctx, p, r);
    const release = releaseFor(r.model, r.routes);
    f.released = release !== null;
    await runJob(p, "release", release);

    r.signal.throwIfAborted();
    ctx.states.transition(p.id, "starting");
    f.upAttempted = true;
    await startStack(p);
    const target = waitTargetFor(p, r);
    await waitHealthy(ctx, target);
    await waitAnswering(ctx, target);
    p.log("rebuilt: awake");
    ctx.states.transition(p.id, "awake");
    await keepDeployed(ctx, r);
    // Untag first: the replaced images are then removed as before, and `:prev` keeps none.
    await dropPrevious(ctx, scopeOf(p, r), f.previous);
    await removeReplaced(ctx, images, before, p.id);
    if (shared) {
      await dropProjectNetwork(ctx, r.host, p.base.project);
    }
    return outcomeOf(ctx, r, "succeeded");
  } catch (e) {
    return await rebuildFailed(ctx, p, r, { ...f, e });
  } finally {
    await r.wd.cleanup();
  }
}
