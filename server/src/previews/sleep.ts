/**
 * Idle-sleep and wake. Sleep acts on the whole project: `compose stop`, file-less by `-p`,
 * from an empty directory like teardown. Routes stay, ports stay claimed, the row says
 * `asleep`; TTL keeps counting. Wake is the reverse -- `compose start`, then the same health
 * wait and HTTP probe a deploy uses -- and happens only on a request, so nothing bulk-starts
 * sixty stacks just because their routes exist.
 */
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
import { StepFailed, waitAnswering, waitHealthy, type WaitTarget } from "./deploy.ts";

export type IdleReport = {
  candidates: number;
  slept: string[];
  skipped: string[];
  failed: string[];
};

/** Stops an awake preview's project and marks it asleep. Leaves it awake if `stop` fails. */
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

/**
 * The `idle-sleep` job. Every awake preview whose last request is older than its idle
 * window -- the row's own (pinned from `x-gangway.idle` or its template), else the default
 * template's for rows older than templates -- is put to sleep.
 * What the proxy noted in memory is flushed first, or a preview visited a second ago
 * would look idle since its last flush.
 */
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

/**
 * Wakes a preview on request: one wake per preview at a time, and every request that
 * arrives while it runs waits on the same promise. A wake that fails puts the preview
 * back to `asleep` with the reason in its log -- not `failed`, which would 502 every
 * later request for a transient cause.
 */
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
    // In flight like a deploy: the reconciler must not read this `starting` as a pipeline a
    // restart interrupted (a slow start, such as a Postgres add-on's, lets a pass land in the
    // middle, mark the preview failed and `down` it under the wake), and a destroy can abort
    // it and wait.
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
      // Still asleep -- unless destroy took it while we were trying.
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
