import type { DockerClients } from "../docker/client.ts";
import type { Hooks } from "../forge/hooks.ts";
import type { PreviewContext } from "../previews/context.ts";
import type { ReconcileReport } from "../reconcile/reconciler.ts";
import { flushLastSeen } from "../scheduler/jobs.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { drain } from "../util/async.ts";
import type { Core } from "./core.ts";
import type { Network } from "./network.ts";

export type ShutdownDeps = Pick<Core, "db" | "logger"> & {
  shutdown: AbortController;
  network: Pick<Network, "listener" | "redirect">;
  scheduler: Scheduler;
  reconciled: Promise<ReconcileReport | null>;
  ctx: PreviewContext;
  hooks: Hooks;
  dockerClients: DockerClients;
};

export function createStop(d: ShutdownDeps): (graceMs: number) => Promise<void> {
  const { listener, redirect } = d.network;
  const { ctx } = d;
  return async (graceMs) => {
    const began = Date.now();
    d.shutdown.abort();
    void redirect?.stop(true);
    void listener.stop(false);

    const left = () => Math.max(0, graceMs - (Date.now() - began));
    await d.scheduler.stop(graceMs);
    await d.reconciled;
    const drained = await drain(
      () => listener.pending().requests === 0 && ctx.inflight.size === 0 && d.hooks.inflight === 0,
      { timeoutMs: left() },
    );

    // The next boot's reconciler rescues pipelines aborted here.
    const cut = {
      requests: listener.pending().requests,
      webSockets: listener.pending().webSockets,
      pipelines: ctx.inflight.size,
    };
    for (const { abort } of ctx.inflight.values()) abort.abort();
    await Promise.allSettled([...ctx.inflight.values()].map((i) => i.done));
    listener.stop(true);

    try {
      flushLastSeen(ctx);
    } catch (e) {
      d.logger.warn("final lastSeen flush failed", { err: e });
    }
    d.dockerClients.closeAll();
    d.logger.info("stopped", { drained, ms: Date.now() - began, ...(drained ? {} : { cut }) });
    d.db.close();
  };
}
