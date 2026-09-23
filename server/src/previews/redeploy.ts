import type { AddonRequest, AppPlan } from "@gangway/shared/app-plan";
import type { Host, Preview } from "@gangway/shared/domain";
import { actorId, mayRebuild, type Actor } from "../auth/actor.ts";
import { psArgv, upArgv } from "../docker/compose.ts";
import { AppError, conflict, forbidden, notFound, errorMessage } from "../errors.ts";
import { ulid } from "../util/ulid.ts";
import type { PlannedRoute } from "./compose-routes.ts";
import type { PreviewContext } from "./context.ts";
import {
  buildImages,
  failStack,
  failureMessage,
  openPipeline,
  runJob,
  startStack,
  waitTargetFor,
  type Pipeline,
  type RunPlan,
} from "./pipeline.ts";
import { planRebuild, type Rebuild, type RebuildPlan } from "./rebuild-plan.ts";
import { imageIds, removeReplaced } from "./replaced-images.ts";
import type { RuntimeChoice } from "./runtimes.ts";
import type { SourceEdits } from "./source-edits.ts";
import type { SourceStore } from "./source/store.ts";
import type { TarballSource } from "./source/tarball.ts";
import { writeStack } from "./stack-file.ts";
import { releaseFor } from "./steps.ts";
import { waitAnswering, waitHealthy } from "./wait.ts";

export { checkEditPath, type SourceEdits } from "./source-edits.ts";

export type RedeployInput = {
  actor: Actor;
  previewId: string;
  change: { kind: "replace"; archive: TarballSource } | { kind: "edit"; files: SourceEdits };
  runtime?: RuntimeChoice | undefined;
  addons?: readonly AddonRequest[] | undefined;
};

export type RedeployOutcome = {
  preview: Preview;
  buildId: string;
  outcome: "succeeded" | "failed";
  error?: string;
};
export type RedeployResult = {
  preview: Preview;
  buildId: string;
  done: Promise<RedeployOutcome>;
  plan?: AppPlan | undefined;
};

const REBUILD_REFUSAL =
  'this preview was deployed by someone else: "previews.update_own" covers only your own, and rebuilding any preview needs "previews.update" (the `update` scope for a token or an agent)';

const routesOf = (ctx: PreviewContext, previewId: string): PlannedRoute[] =>
  ctx.table.forPreview(previewId).map((e) => ({
    hostname: e.hostname,
    previewId: e.previewId,
    service: e.service,
    containerPort: e.containerPort,
    upstream: { host: e.upstreamHost, port: e.upstreamPort },
    primary: e.primary,
  }));

async function checkRebuildable(
  ctx: PreviewContext,
  input: RedeployInput,
): Promise<{ host: Host; sources: SourceStore }> {
  const id = input.previewId;
  const current = ctx.previews.get(id);
  if (!current || current.state === "destroyed") throw notFound(`no such preview: ${id}`);
  if (!mayRebuild(input.actor, ctx.previews.ownerOf(id))) throw forbidden(REBUILD_REFUSAL);
  if (current.source.kind !== "tarball" || !ctx.sources || !(await ctx.sources.has(id))) {
    throw conflict(
      "only an uploaded preview can be rebuilt from a new source; this one keeps none",
    );
  }
  const host = ctx.hosts.get(current.hostId);
  if (!host) throw new AppError("internal", `preview ${id} is on unknown host ${current.hostId}`);
  return { host, sources: ctx.sources };
}

type Claimed = {
  preview: Preview;
  abort: AbortController;
  done: Promise<RedeployOutcome>;
  settle: (o: RedeployOutcome) => void;
};

// No await from these checks until the inflight claim, so two saves can't both get past.
function claimRebuild(ctx: PreviewContext, id: string): Claimed {
  const preview = ctx.previews.get(id)!;
  if (!["awake", "asleep", "failed"].includes(preview.state)) {
    throw conflict(`the preview is ${preview.state}; wait for it to settle`, {
      state: preview.state,
    });
  }
  if (ctx.inflight.has(id) || ctx.teardowns.has(id))
    throw conflict("a deploy of this preview is still running");
  const abort = new AbortController();
  let settle!: (o: RedeployOutcome) => void;
  const done = new Promise<RedeployOutcome>((r) => {
    settle = r;
  });
  ctx.inflight.set(id, { abort, done: done.then((o) => o.preview) });
  return { preview, abort, done, settle };
}

function announce(ctx: PreviewContext, b: Rebuild, plan: RebuildPlan, buildId: string): void {
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
      runtime: plan.next.kind === "tarball" ? (plan.next.runtime ?? "own") : null,
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
  const b: Rebuild = { input, sources, preview, host, wd, routes: routesOf(ctx, id) };
  let plan: RebuildPlan;
  try {
    plan = await planRebuild(ctx, b);
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
    addonServices: plan.addonServices,
  };
  void run(ctx, r)
    .then(
      (o) => settle(o),
      (e: unknown) =>
        settle({
          preview: ctx.previews.get(id) ?? preview,
          buildId,
          outcome: "failed",
          error: String(e),
        }),
    )
    .finally(() => {
      ctx.inflight.delete(id);
    });

  return { preview: ctx.previews.get(id)!, buildId, done, plan: plan.app };
}

type RebuildRun = RunPlan & { buildId: string; addonServices: string[] };

function outcomeOf(
  ctx: PreviewContext,
  r: RebuildRun,
  o: "succeeded" | "failed",
  error?: string,
): RedeployOutcome {
  const id = r.preview.id;
  ctx.bus.publish(
    "preview.redeploy",
    { phase: o, buildId: r.buildId, ...(error ? { error } : {}) },
    id,
  );
  return {
    preview: ctx.previews.get(id) ?? r.preview,
    buildId: r.buildId,
    outcome: o,
    ...(error ? { error } : {}),
  };
}

async function startAddons(ctx: PreviewContext, p: Pipeline, r: RebuildRun): Promise<void> {
  if (r.addonServices.length === 0) return;
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

async function rebuildFailed(
  ctx: PreviewContext,
  p: Pipeline,
  r: RebuildRun,
  e: unknown,
  upAttempted: boolean,
): Promise<RedeployOutcome> {
  // destroy() aborted the run and owns the preview from here.
  if (r.signal.aborted)
    return {
      preview: ctx.previews.get(p.id) ?? r.preview,
      buildId: r.buildId,
      outcome: "failed",
      error: "cancelled",
    };
  const message = failureMessage(ctx, p.id, e, "redeploy pipeline error");
  const state = ctx.previews.get(p.id)?.state;
  if (!upAttempted && state !== "building") {
    p.log(`rebuild FAILED: ${message} -- the previous version is still serving`);
    return outcomeOf(ctx, r, "failed", message);
  }
  await failStack(ctx, r, message, upAttempted);
  return outcomeOf(ctx, r, "failed", message);
}

async function run(ctx: PreviewContext, r: RebuildRun): Promise<RedeployOutcome> {
  const p = openPipeline(ctx, r);
  if (ctx.previews.get(p.id)?.state === "failed") ctx.states.transition(p.id, "building");

  let upAttempted = false;
  try {
    await writeStack(ctx, p.stackPath, r);
    const before = await imageIds(ctx, r.host, p.base, r.wd.srcDir);
    await buildImages(ctx, p, r, r.buildId);
    await startAddons(ctx, p, r);
    await runJob(p, "release", releaseFor(r.model, r.routes));

    r.signal.throwIfAborted();
    ctx.states.transition(p.id, "starting");
    upAttempted = true;
    await startStack(p);
    const target = waitTargetFor(p, r);
    await waitHealthy(ctx, target);
    await waitAnswering(ctx, target);
    p.log("rebuilt: awake");
    ctx.states.transition(p.id, "awake");
    await removeReplaced(ctx, r.host, p.base, r.wd.srcDir, before, p.id);
    return outcomeOf(ctx, r, "succeeded");
  } catch (e) {
    return await rebuildFailed(ctx, p, r, e, upAttempted);
  } finally {
    await r.wd.cleanup();
  }
}
