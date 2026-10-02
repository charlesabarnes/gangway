import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Host, Preview } from "@gangway/shared/domain";
import { buildArgv, psArgv, runArgv, upArgv, type ComposeSpec } from "../docker/compose.ts";
import { AppError, errorMessage } from "../errors.ts";
import { redactString } from "../logger.ts";
import { LineFull } from "../util/async.ts";
import { ulid } from "../util/ulid.ts";
import type { BuildingContext, PreviewContext } from "./context.ts";
import type { Workdir } from "./source/workdir.ts";
import { STACK_FILE, type StackPlan } from "./stack-file.ts";
import { healthOf, StepFailed, stepper, type Job, type Step } from "./steps.ts";
import { salvage, type WaitTarget } from "./wait.ts";

export type ComposeBase = Omit<ComposeSpec, "command" | "args">;

export type RunPlan = StackPlan & { wd: Workdir; signal: AbortSignal };

export type Pipeline = {
  id: string;
  stackPath: string;
  base: ComposeBase;
  step: Step;
  log: (line: string) => void;
};

export function openPipeline(
  ctx: Pick<PreviewContext, "compose" | "docker" | "logs">,
  r: RunPlan,
): Pipeline {
  const id = r.preview.id;
  const stackPath = join(r.wd.dir, STACK_FILE);
  return {
    id,
    stackPath,
    base: {
      project: r.preview.project,
      files: [stackPath],
      projectDirectory: r.wd.srcDir,
      docker: ctx.docker,
    },
    step: stepper(ctx, { previewId: id, host: r.host, cwd: r.wd.srcDir, signal: r.signal }),
    log: (line) => {
      ctx.logs.append(id, "system", line);
    },
  };
}

export async function buildImages(
  ctx: BuildingContext,
  p: Pipeline,
  r: RunPlan,
  buildId?: string,
): Promise<void> {
  const toBuild = r.model.services.filter((s) => s.hasBuild).map((s) => s.name);
  if (toBuild.length === 0) {
    return;
  }
  const release = await buildSlot(ctx, p, r);
  try {
    const refused = await ctx.buildRoom?.(r.host);
    if (refused) {
      throw new AppError("unavailable", `not building now: ${refused}`);
    }
    await recordBuild(ctx, p, r, { id: buildId ?? ulid(ctx.now()), services: toBuild });
  } finally {
    release?.();
  }
}

async function buildSlot(ctx: PreviewContext, p: Pipeline, r: RunPlan) {
  try {
    return await ctx.buildSlots?.acquire(r.signal, () => {
      p.log(`waiting for a build slot (${ctx.buildSlots?.waiting ?? 0} ahead)`);
    });
  } catch (e) {
    if (e instanceof LineFull) {
      throw new AppError(
        "unavailable",
        `${e.waiting} builds are already waiting; try again in a few minutes (previews.limits.buildQueue)`,
      );
    }
    throw e;
  }
}

async function recordBuild(
  ctx: BuildingContext,
  p: Pipeline,
  r: RunPlan,
  { id, services }: { id: string; services: string[] },
): Promise<void> {
  ctx.builds.start({ id, previewId: p.id, services });
  try {
    await p.step("build", buildArgv(p.base, services), "build");
    ctx.builds.finish(id, "succeeded", 0);
  } catch (e) {
    ctx.builds.finish(
      id,
      r.signal.aborted ? "cancelled" : "failed",
      e instanceof StepFailed ? e.exitCode : null,
    );
    throw e;
  }
}

const JOB_LOG = { release: "release", seed: "seeding" } as const;

export async function runJob(p: Pipeline, kind: "release" | "seed", job: Job | null) {
  if (!job) {
    return;
  }
  p.log(`${JOB_LOG[kind]}: ${job.command} (in ${job.service})`);
  await p.step(
    `run (${kind})`,
    runArgv(p.base, job.service, ["sh", "-c", job.command], ["--no-deps", "-T"]),
    "seed",
  );
}

export async function startStack(p: Pipeline, dockerConfig?: string): Promise<void> {
  try {
    await p.step(
      "up",
      upArgv(p.base, ["--no-build", "--remove-orphans"]),
      "stdout",
      dockerConfig ? { DOCKER_CONFIG: dockerConfig } : undefined,
    );
  } finally {
    if (dockerConfig) {
      await rm(dockerConfig, { recursive: true, force: true });
    }
  }
}

export const waitTargetFor = (p: Pipeline, r: RunPlan): WaitTarget => ({
  previewId: p.id,
  host: r.host,
  routes: r.routes,
  signal: r.signal,
  ps: psArgv(p.base, ["--all"]),
  cwd: r.wd.srcDir,
  health: healthOf(r.model),
});

export function failureMessage(
  ctx: Pick<PreviewContext, "logger">,
  previewId: string,
  e: unknown,
  what: string,
): string {
  const message = redactString(errorMessage(e));
  if (!(e instanceof StepFailed)) {
    ctx.logger.error(what, { previewId, err: e });
  }
  return message;
}

export async function failStack(
  ctx: BuildingContext,
  r: { preview: Preview; host: Host },
  message: string,
  upAttempted: boolean,
): Promise<Preview> {
  ctx.logs.append(r.preview.id, "system", `FAILED: ${message}`);
  if (upAttempted) {
    await salvage(ctx, r);
  }
  return ctx.states.transition(r.preview.id, "failed", message);
}
