import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servedByGangway, type Host, type Preview } from "@gangway/shared/domain";
import { psArgv, startArgv, stopArgv } from "../docker/compose.ts";
import { AppError, errorMessage, forbidden } from "../errors.ts";
import { type Logger, redactString } from "../logger.ts";
import { idleMs } from "../util/duration.ts";
import { SingleFlight } from "../util/async.ts";
import { withOrg } from "../tenancy/scope.ts";
import type { LifecycleContext, PreviewContext } from "./context.ts";
import { StepFailed } from "./steps.ts";
import { waitAnswering, waitHealthy, type WaitTarget } from "./wait.ts";

export type IdleReport = {
  candidates: number;
  slept: string[];
  skipped: string[];
  failed: string[];
};

export async function sleepPreview(
  ctx: LifecycleContext,
  previewId: string,
  why: string,
): Promise<Preview> {
  const preview = ctx.previews.get(previewId);
  if (preview?.state !== "awake") {
    throw new AppError("conflict", `preview ${previewId} is not awake`);
  }
  if (servedByGangway(preview)) {
    throw new AppError("conflict", `gangway serves preview ${previewId}'s files; nothing sleeps`);
  }
  const host = ctx.hosts.get(preview.hostId);
  if (!host) {
    throw new AppError("conflict", `host ${preview.hostId} is gone`);
  }
  if (ctx.inflight.has(previewId) || ctx.teardowns.has(previewId)) {
    throw new AppError("conflict", `preview ${previewId} is busy`);
  }

  await stopStack(ctx, preview, host);
  ctx.logs.append(previewId, "system", `asleep: ${why}`);
  return ctx.states.transition(previewId, "asleep");
}

export async function stopStack(
  ctx: LifecycleContext,
  preview: Preview,
  host: Host,
): Promise<void> {
  const empty = await mkdtemp(join(tmpdir(), "gangway-sleep-"));
  try {
    const res = await ctx.compose.capture(
      stopArgv({ project: preview.project, files: [], docker: ctx.docker }),
      host,
      { cwd: empty },
    );
    if (res.code !== 0) {
      throw new Error(`compose stop exited ${res.code}: ${res.stderr.slice(-500)}`);
    }
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}

const nameOf = (p: Preview) => p.title ?? p.project;

export type AwakeContext = LifecycleContext & Pick<PreviewContext, "orgLimits" | "blocks">;

/** Sleeps the org's least recently seen previews to keep `maxAwake`; refuses only a suspended org. */
export async function makeAwakeRoom(ctx: AwakeContext, preview: Preview): Promise<string[]> {
  if (ctx.blocks?.suspended(preview.orgId)) {
    throw forbidden("this org is suspended: its previews cannot start");
  }
  const max = ctx.orgLimits?.(preview.orgId)?.maxAwake;
  if (max === undefined) {
    return [];
  }
  ctx.previews.touchMany(ctx.table.drainSeen());
  const others = withOrg(preview.orgId, () =>
    ctx.previews.list({ state: ["awake", "starting"], kind: "preview" }),
  ).filter((p) => p.orgId === preview.orgId && p.id !== preview.id && !servedByGangway(p));
  let over = others.length + 1 - max;
  const seen = (p: Preview) => (p.lastSeenAt ?? p.createdAt).getTime();
  const idle = others
    .filter((p) => p.state === "awake" && !ctx.inflight.has(p.id) && !ctx.teardowns.has(p.id))
    .sort((a, b) => seen(a) - seen(b));
  const slept: string[] = [];
  for (const p of idle) {
    if (over <= 0) {
      break;
    }
    try {
      await sleepPreview(
        ctx,
        p.id,
        `the org's plan allows ${max} awake, and ${nameOf(preview)} started`,
      );
      slept.push(nameOf(p));
      over--;
    } catch (err) {
      ctx.logger.warn("could not sleep a preview to make room", { previewId: p.id, err });
    }
  }
  if (slept.length > 0) {
    ctx.logs.append(
      preview.id,
      "system",
      `put ${slept.join(", ")} to sleep: the org's plan allows ${max} awake`,
    );
  }
  return slept;
}

export async function sweepIdle(
  ctx: LifecycleContext,
  logger: Logger,
  signal?: AbortSignal,
): Promise<IdleReport> {
  ctx.previews.touchMany(ctx.table.drainSeen());
  const now = ctx.now();
  const defaultMs = idleMs(ctx.policy.default().idleAfter);
  const report: IdleReport = { candidates: 0, slept: [], skipped: [], failed: [] };

  for (const p of ctx.previews.list({ state: "awake", kind: "preview" })) {
    if (signal?.aborted) {
      break;
    }
    // Files cost nothing while nobody reads them.
    if (servedByGangway(p)) {
      continue;
    }
    const windowMs = p.idleAfterMs ?? defaultMs;
    if (windowMs <= 0) {
      continue;
    }
    const lastSeen = (p.lastSeenAt ?? p.createdAt).getTime();
    if (now - lastSeen < windowMs) {
      continue;
    }
    report.candidates++;
    if (
      ctx.inflight.has(p.id) ||
      ctx.teardowns.has(p.id) ||
      ctx.hosts.get(p.hostId)?.state === "unreachable"
    ) {
      report.skipped.push(p.id);
      continue;
    }
    try {
      await sleepPreview(ctx, p.id, `idle for ${Math.round((now - lastSeen) / 60_000)} min`);
      report.slept.push(p.id);
    } catch (err) {
      report.failed.push(p.id);
      logger.warn("idle sweep could not stop a preview", {
        previewId: p.id,
        project: p.project,
        err,
      });
    }
  }
  if (report.slept.length || report.failed.length) {
    logger.info("idle sweep", {
      slept: report.slept.length,
      failed: report.failed.length,
      skipped: report.skipped.length,
    });
  }
  return report;
}

export class Waker {
  readonly #ctx: AwakeContext;
  readonly #log: Logger;
  readonly #flights = new SingleFlight<Preview>();

  constructor(ctx: AwakeContext, log: Logger) {
    this.#ctx = ctx;
    this.#log = log;
  }

  get waking(): number {
    return this.#flights.size;
  }

  wake(previewId: string): Promise<Preview> {
    return this.#flights.run(previewId, () => this.#wake(previewId));
  }

  async #wake(previewId: string): Promise<Preview> {
    const ctx = this.#ctx;
    const preview = ctx.previews.get(previewId);
    if (!preview) {
      throw new AppError("not_found", `no such preview: ${previewId}`);
    }
    if (preview.state === "awake") {
      return preview;
    }
    if (preview.state !== "asleep") {
      throw new AppError("conflict", `preview ${previewId} is ${preview.state}, not asleep`);
    }
    const host = ctx.hosts.get(preview.hostId);
    if (!host) {
      throw new AppError("conflict", `host ${preview.hostId} is gone`);
    }
    if (host.state === "unreachable") {
      throw new AppError("conflict", `host ${host.id} is unreachable`);
    }

    const routes = ctx.table.forPreview(previewId).map((e) => ({
      service: e.service,
      hostname: e.hostname,
      containerPort: e.containerPort,
      upstream: { host: e.upstreamHost, port: e.upstreamPort },
    }));
    const base = { project: preview.project, files: [], docker: ctx.docker };
    const empty = await mkdtemp(join(tmpdir(), "gangway-wake-"));
    const abort = new AbortController();
    // Registered as inflight so the reconciler doesn't fail a slow wake and destroy can abort it.
    let settle!: (p: Preview) => void;
    const done = new Promise<Preview>((r) => {
      settle = r;
    });
    if (ctx.inflight.has(previewId)) {
      await rm(empty, { recursive: true, force: true });
      throw new AppError("conflict", `preview ${previewId} is busy`);
    }
    try {
      ctx.inflight.set(previewId, { abort, done });
      await makeAwakeRoom(ctx, preview);
      ctx.logs.append(previewId, "system", "waking");
      ctx.states.transition(previewId, "starting");
      const res = await ctx.compose.capture(startArgv(base), host, {
        cwd: empty,
        signal: abort.signal,
      });
      if (res.code !== 0) {
        throw new StepFailed(
          `compose start exited ${res.code}: ${res.stderr.slice(-300)}`,
          res.code,
        );
      }
      const target: WaitTarget = {
        previewId,
        host,
        routes,
        signal: abort.signal,
        ps: psArgv(base, ["--all"]),
        cwd: empty,
      };
      await waitHealthy(ctx, target);
      await waitAnswering(ctx, target);
      ctx.logs.append(previewId, "system", "awake");
      return ctx.states.transition(previewId, "awake");
    } catch (e) {
      const message = redactString(errorMessage(e));
      ctx.logs.append(previewId, "system", `wake failed: ${message}`);
      this.#log.warn("wake failed", { previewId, project: preview.project, err: e });
      const now = ctx.previews.get(previewId);
      if (now?.state === "starting") {
        ctx.states.transition(previewId, "asleep");
      }
      throw e;
    } finally {
      ctx.inflight.delete(previewId);
      settle(ctx.previews.get(previewId) ?? preview);
      await rm(empty, { recursive: true, force: true });
    }
  }
}
