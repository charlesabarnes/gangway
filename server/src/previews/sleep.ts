import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Preview } from "@gangway/shared/domain";
import { psArgv, startArgv, stopArgv } from "../docker/compose.ts";
import { AppError, errorMessage } from "../errors.ts";
import { type Logger, redactString } from "../logger.ts";
import { idleMs } from "../util/duration.ts";
import { SingleFlight } from "../util/async.ts";
import type { PreviewContext } from "./context.ts";
import { StepFailed } from "./steps.ts";
import { waitAnswering, waitHealthy, type WaitTarget } from "./wait.ts";

export type IdleReport = {
  candidates: number;
  slept: string[];
  skipped: string[];
  failed: string[];
};

export async function sleepPreview(
  ctx: PreviewContext,
  previewId: string,
  why: string,
): Promise<Preview> {
  const preview = ctx.previews.get(previewId);
  if (!preview || preview.state !== "awake")
    throw new AppError("conflict", `preview ${previewId} is not awake`);
  const host = ctx.hosts.get(preview.hostId);
  if (!host) throw new AppError("conflict", `host ${preview.hostId} is gone`);
  if (ctx.inflight.has(previewId) || ctx.teardowns.has(previewId))
    throw new AppError("conflict", `preview ${previewId} is busy`);

  const empty = await mkdtemp(join(tmpdir(), "gangway-sleep-"));
  try {
    const res = await ctx.compose.capture(
      stopArgv({ project: preview.project, files: [], docker: ctx.docker }),
      host,
      { cwd: empty },
    );
    if (res.code !== 0)
      throw new Error(`compose stop exited ${res.code}: ${res.stderr.slice(-500)}`);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
  ctx.logs.append(previewId, "system", `asleep: ${why}`);
  return ctx.states.transition(previewId, "asleep");
}

export async function sweepIdle(
  ctx: PreviewContext,
  logger: Logger,
  signal?: AbortSignal,
): Promise<IdleReport> {
  ctx.previews.touchMany(ctx.table.drainSeen());
  const now = ctx.now();
  const defaultMs = idleMs(ctx.policy.default().idleAfter);
  const report: IdleReport = { candidates: 0, slept: [], skipped: [], failed: [] };

  for (const p of ctx.previews.list({ state: "awake", kind: "preview" })) {
    if (signal?.aborted) break;
    const windowMs = p.idleAfterMs ?? defaultMs;
    if (windowMs <= 0) continue;
    const lastSeen = (p.lastSeenAt ?? p.createdAt).getTime();
    if (now - lastSeen < windowMs) continue;
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
  readonly #ctx: PreviewContext;
  readonly #log: Logger;
  readonly #flights = new SingleFlight<Preview>();

  constructor(ctx: PreviewContext, log: Logger) {
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
    if (!preview) throw new AppError("not_found", `no such preview: ${previewId}`);
    if (preview.state === "awake") return preview;
    if (preview.state !== "asleep")
      throw new AppError("conflict", `preview ${previewId} is ${preview.state}, not asleep`);
    const host = ctx.hosts.get(preview.hostId);
    if (!host) throw new AppError("conflict", `host ${preview.hostId} is gone`);
    if (host.state === "unreachable")
      throw new AppError("conflict", `host ${host.id} is unreachable`);

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
    ctx.inflight.set(previewId, { abort, done });
    ctx.logs.append(previewId, "system", "waking");
    ctx.states.transition(previewId, "starting");
    try {
      const res = await ctx.compose.capture(startArgv(base), host, {
        cwd: empty,
        signal: abort.signal,
      });
      if (res.code !== 0)
        throw new StepFailed(
          `compose start exited ${res.code}: ${res.stderr.slice(-300)}`,
          res.code,
        );
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
      if (now?.state === "starting") ctx.states.transition(previewId, "asleep");
      throw e;
    } finally {
      ctx.inflight.delete(previewId);
      settle(ctx.previews.get(previewId) ?? preview);
      await rm(empty, { recursive: true, force: true });
    }
  }
}
