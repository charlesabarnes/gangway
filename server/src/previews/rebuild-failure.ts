import type { Preview } from "@gangway/shared/domain";
import { ulid } from "../util/ulid.ts";
import type { PreviewContext } from "./context.ts";
import {
  failStack,
  failureMessage,
  openPipeline,
  startStack,
  waitTargetFor,
  type Pipeline,
  type RunPlan,
} from "./pipeline.ts";
import {
  dropPrevious,
  removeUntagged,
  restorePrevious,
  type ProjectScope,
} from "./previous-images.ts";
import { planRebuild, type Rebuild, type RebuildPlan } from "./rebuild-plan.ts";
import { writeStack } from "./stack-file.ts";
import { keepLastLogs, waitAnswering, waitHealthy } from "./wait.ts";

export type RedeployOutcome = {
  preview: Preview;
  buildId: string;
  outcome: "succeeded" | "failed";
  error?: string;
};
export type RebuildRun = RunPlan & {
  buildId: string;
  addonServices: string[];
  /** What the rebuild was asked for: planned again from the deployed source to roll back. */
  rebuild: Rebuild;
  keep: RebuildPlan["keep"];
  /** The serving version's images kept as `:prev`, or null when nothing served to roll back to. */
  previous: string[] | null;
};

export function outcomeOf(
  ctx: Pick<PreviewContext, "bus" | "previews">,
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

/** Losing the failed edits must not stop the rollback or the cleanup after it. */
export async function keepDraft(ctx: Pick<PreviewContext, "logger">, r: RebuildRun): Promise<void> {
  try {
    await r.keep("draft");
  } catch (e) {
    ctx.logger.error("could not keep a failed rebuild's draft", {
      previewId: r.preview.id,
      err: e,
    });
  }
}

export type Failure = {
  e: unknown;
  upAttempted: boolean;
  /** The release job started: the database may be migrated ahead of what is serving. */
  released: boolean;
  /** The serving version's built images, tagged to roll back to. */
  previous: string[];
};

const MIGRATED_AHEAD =
  "warning: the release command ran before the failure; the database may be migrated ahead of the version that is serving";

export async function rebuildFailed(
  ctx: PreviewContext,
  p: Pipeline,
  r: RebuildRun,
  f: Failure,
): Promise<RedeployOutcome> {
  const scope = scopeOf(p, r);
  // destroy() aborted the run and owns the preview from here.
  const cancelled = async (): Promise<RedeployOutcome> => {
    await dropPrevious(ctx, scope, f.previous);
    return {
      preview: ctx.previews.get(p.id) ?? r.preview,
      buildId: r.buildId,
      outcome: "failed",
      error: "cancelled",
    };
  };
  if (r.signal.aborted) {
    return cancelled();
  }
  const message = failureMessage(ctx, p.id, f.e, "redeploy pipeline error");
  await keepDraft(ctx, r);
  const state = ctx.previews.get(p.id)?.state;
  if (!f.upAttempted && state !== "building") {
    p.log(`rebuild FAILED: ${message} -- the previous version is still serving`);
    if (f.released) {
      p.log(MIGRATED_AHEAD);
    }
    // `:latest` goes back to what is serving, and a build that never served goes.
    if (await restorePrevious(ctx, scope, f.previous)) {
      await removeUntagged(ctx, scope);
    }
    return outcomeOf(ctx, r, "failed", message);
  }
  if (f.upAttempted && r.previous !== null) {
    p.log(`rebuild FAILED: ${message} -- rolling back to the previous version`);
    if (f.released) {
      p.log(MIGRATED_AHEAD);
    }
    const back = await rollBack(ctx, r, f.previous);
    if (back === "serving") {
      p.log("rolled back to the previous version; it is serving again");
      ctx.states.transition(p.id, "awake");
      await removeUntagged(ctx, scope);
      return outcomeOf(ctx, r, "failed", message);
    }
    if (back === "cancelled") {
      return cancelled();
    }
  }
  await dropPrevious(ctx, scope, f.previous);
  await failStack(ctx, r, message, f.upAttempted);
  return outcomeOf(ctx, r, "failed", message);
}

export const scopeOf = (p: Pipeline, r: RebuildRun): ProjectScope => ({
  host: r.host,
  project: p.base.project,
  cwd: r.wd.srcDir,
});

/** Plan the deployed source again, point `:latest` back at its images and start it, no build. */
async function rollBack(
  ctx: PreviewContext,
  r: RebuildRun,
  previous: string[],
): Promise<"serving" | "failed" | "cancelled"> {
  const id = r.preview.id;
  const was = r.preview.source;
  if (was.kind !== "tarball") {
    return "failed";
  }
  await keepLastLogs(ctx, r, r.wd.srcDir).catch(() => undefined);
  const wd = await ctx.workdirs.create(ulid(ctx.now()));
  try {
    const old = await planRebuild(ctx, {
      ...r.rebuild,
      wd,
      restore: true,
      input: {
        ...r.rebuild.input,
        runtime: was.runtime ?? "own",
        addons: undefined,
        network: undefined,
      },
    });
    if (old.site) {
      return "failed";
    }
    const back: RunPlan = {
      preview: r.preview,
      host: r.host,
      wd,
      routes: r.routes,
      visibility: r.visibility,
      signal: r.signal,
      ...old.planned,
      source: was,
    };
    const p = openPipeline(ctx, back);
    if (!(await restorePrevious(ctx, { ...scopeOf(p, r), cwd: wd.srcDir }, previous))) {
      throw new Error("could not move the previous images back to :latest");
    }
    previous.splice(0);
    await writeStack(ctx, p.stackPath, back);
    await startStack(p);
    const target = waitTargetFor(p, back);
    await waitHealthy(ctx, target);
    await waitAnswering(ctx, target);
    return "serving";
  } catch (e) {
    if (r.signal.aborted) {
      return "cancelled";
    }
    const message = failureMessage(ctx, id, e, "rollback error");
    ctx.logs.append(id, "system", `rollback FAILED: ${message}`);
    return "failed";
  } finally {
    await wd.cleanup();
  }
}
