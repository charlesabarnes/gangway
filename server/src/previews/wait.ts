import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host, Preview, Route } from "@gangway/shared/domain";
import { composeArgv, downArgv, parseComposePs } from "../docker/compose.ts";
import { sleep } from "../util/async.ts";
import type { PreviewContext } from "./context.ts";
import { rmiFor } from "./destroy.ts";
import { StepFailed } from "./steps.ts";

export type WaitTarget = {
  previewId: string;
  host: Host;
  routes: Pick<Route, "service" | "hostname" | "upstream" | "containerPort">[];
  signal: AbortSignal;
  ps: string[];
  cwd: string;
  health?: Record<string, string> | undefined;
};

export async function waitHealthy(ctx: PreviewContext, r: WaitTarget): Promise<void> {
  const deadline = Date.now() + ctx.timings.startTimeoutMs;
  const argv = r.ps;
  let last = "";
  for (;;) {
    r.signal.throwIfAborted();
    const res = await ctx.compose.capture(argv, r.host, { cwd: r.cwd, signal: r.signal });
    const rows = res.code === 0 ? parseComposePs(res.stdout) : [];
    const routed = new Set(r.routes.map((x) => x.service));

    for (const c of rows) {
      const died =
        c.state === "dead" || (c.state === "exited" && (c.exitCode !== 0 || routed.has(c.service)));
      if (died)
        throw new StepFailed(
          `service "${c.service}" exited${c.exitCode === null ? "" : ` with code ${c.exitCode}`}`,
        );
      if (c.health === "unhealthy") throw new StepFailed(`service "${c.service}" is unhealthy`);
    }
    const waiting = rows
      .filter((c) => !(c.state === "exited" && c.exitCode === 0))
      .filter((c) => c.state !== "running" || (c.health !== null && c.health !== "healthy"));
    const seen = new Set(rows.map((c) => c.service));
    const missing = [...routed].filter((s) => !seen.has(s));
    if (rows.length > 0 && waiting.length === 0 && missing.length === 0) return;

    const status = [
      ...waiting.map((c) => `${c.service}: ${c.health ?? c.state}`),
      ...missing.map((s) => `${s}: not created`),
    ].join(", ");
    if (status !== last) {
      ctx.logs.append(r.previewId, "system", `waiting for ${status || "containers"}`);
      last = status;
    }
    if (Date.now() >= deadline)
      throw new StepFailed(
        `timed out after ${Math.round(ctx.timings.startTimeoutMs / 1000)}s waiting for ${status || "containers"}`,
      );
    await sleep(ctx.timings.pollIntervalMs);
  }
}

export async function waitAnswering(ctx: PreviewContext, r: WaitTarget): Promise<void> {
  const deadline = Date.now() + ctx.timings.probeTimeoutMs;
  let pending = [...r.routes];
  for (;;) {
    r.signal.throwIfAborted();
    const results = await Promise.all(
      pending.map((route) => ctx.probe(route, r.host, r.health?.[route.service])),
    );
    pending = pending.filter((_, i) => !results[i]);
    if (pending.length === 0) return;
    if (Date.now() >= deadline) {
      throw new StepFailed(
        `${pending.map((p) => `${p.service}:${p.containerPort}${r.health?.[p.service] ?? ""}`).join(", ")} never answered${r.health && pending.some((p) => r.health![p.service]) ? " with a 2xx/3xx" : " HTTP"} -- is that the right port, and does the app listen on 0.0.0.0?`,
      );
    }
    await sleep(ctx.timings.pollIntervalMs);
  }
}

export async function salvage(
  ctx: PreviewContext,
  r: { preview: Preview; host: Host },
): Promise<void> {
  const empty = await mkdtemp(join(tmpdir(), "gangway-salvage-"));
  try {
    const logs = await ctx.compose.capture(
      composeArgv({
        project: r.preview.project,
        files: [],
        command: "logs",
        args: ["--no-color", "--tail", "60"],
        docker: ctx.docker,
      }),
      r.host,
      { cwd: empty },
    );
    if (logs.stdout) ctx.logs.append(r.preview.id, "stdout", logs.stdout);
    // Keep volumes: a failed rebuild must not take the add-on's data.
    await ctx.compose.capture(
      downArgv(
        { project: r.preview.project, files: [], docker: ctx.docker },
        [],
        rmiFor(r.preview),
        { volumes: false },
      ),
      r.host,
      { cwd: empty },
    );
  } catch (e) {
    ctx.logger.warn("could not tear down a failed stack; the reconciler will", {
      previewId: r.preview.id,
      err: e,
    });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}
