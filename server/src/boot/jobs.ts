import type { Sessions } from "../auth/sessions.ts";
import type { RunningListener } from "../net/listener.ts";
import type { PreviewContext } from "../previews/context.ts";
import type { IdempotentDeploys } from "../previews/idempotent.ts";
import { sweepIdle } from "../previews/sleep.ts";
import { Reconciler, type ClientSource, type ReconcileReport } from "../reconcile/reconciler.ts";
import { flushLastSeen, sweepExpired } from "../scheduler/jobs.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import type { AcmeProvider } from "../tls/acme.ts";
import type { CertStore } from "../tls/certstore.ts";
import type { Core } from "./core.ts";

export type CertRenewal = {
  acme: AcmeProvider;
  domains: string[];
  certStore: CertStore;
  listener: RunningListener;
};

export type Reconciling = { reconciler: Reconciler; reconciled: Promise<ReconcileReport | null> };

export type JobDeps = Pick<Core, "config" | "logger" | "repos"> &
  Reconciling & {
    ctx: PreviewContext;
    deploys: IdempotentDeploys;
    sessions: Sessions;
    renewal: CertRenewal | null;
  };

export function startReconciler(
  { repos, config, logger }: Core,
  ctx: PreviewContext,
  clients: ClientSource,
): Reconciling {
  const reconciler = new Reconciler({
    ctx,
    routes: repos.routes,
    clients,
    logger: logger.child({ mod: "reconcile" }),
    orphans: config.reconcileOrphans,
  });
  const reconciled = reconciler.run().catch((e) => {
    logger.error("boot reconciliation failed", { err: e });
    return null;
  });
  return { reconciler, reconciled };
}

export function startScheduler(d: JobDeps): Scheduler {
  // stop() waits for running jobs, so nothing touches the database after it closes.
  const scheduler = new Scheduler({ logger: d.logger.child({ mod: "scheduler" }) });
  registerPreviewJobs(scheduler, d);
  if (d.renewal) registerCertRenewal(scheduler, d.renewal);
  registerPurges(scheduler, d);
  scheduler.start();
  return scheduler;
}

function registerPreviewJobs(scheduler: Scheduler, d: JobDeps): void {
  const { config, ctx, logger } = d;
  scheduler.register({
    name: "reconcile",
    intervalMs: config.reconcileIntervalMs,
    run: () => d.reconciler.run(),
  });
  scheduler.register({
    name: "ttl-sweep",
    intervalMs: config.ttlSweepIntervalMs,
    // The first sweep waits for the boot reconcile, which learns which hosts are reachable.
    run: async (signal) => {
      await d.reconciled;
      await sweepExpired(ctx, logger.child({ mod: "ttl" }), signal);
    },
    initialDelayMs: 0,
  });
  scheduler.register({
    name: "lastseen-flush",
    intervalMs: config.lastSeenFlushIntervalMs,
    run: () => flushLastSeen(ctx),
  });
  scheduler.register({
    name: "idle-sleep",
    intervalMs: config.idleSweepIntervalMs,
    run: (signal) => sweepIdle(ctx, logger.child({ job: "idle-sleep" }), signal),
  });
}

function registerCertRenewal(scheduler: Scheduler, r: CertRenewal): void {
  r.certStore.onSwap(() => r.listener.swapCerts());
  // Hourly because Let's Encrypt allows 5 failed validations per hour.
  scheduler.register({
    name: "cert-renew",
    intervalMs: 3_600_000,
    initialDelayMs: 0,
    run: async (signal) => {
      const next = await r.acme.renewIfDue(r.domains, signal);
      if (next) await r.certStore.swap(next);
    },
  });
}

function registerPurges(scheduler: Scheduler, d: JobDeps): void {
  scheduler.register({
    name: "idempotency-purge",
    intervalMs: 3_600_000,
    run: () => d.deploys.purge(),
  });
  scheduler.register({
    name: "session-purge",
    intervalMs: 3_600_000,
    run: () => {
      d.sessions.purge();
    },
  });
  scheduler.register({
    name: "oauth-purge",
    intervalMs: 3_600_000,
    run: () => {
      d.repos.oauthGrants.purge(Date.now() - 7 * 86_400_000);
    },
  });
}
