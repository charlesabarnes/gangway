import type { Sessions } from "../auth/sessions.ts";
import type { RunningListener } from "../net/listener.ts";
import type { PreviewContext } from "../previews/context.ts";
import type { IdempotentDeploys } from "../previews/idempotent.ts";
import { sweepIdle } from "../previews/sleep.ts";
import { Reconciler } from "../reconcile/reconciler.ts";
import type { ClientSource, ReconcileReport } from "../reconcile/reconciler-types.ts";
import { flushLastSeen, sweepExpired } from "../scheduler/jobs.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import type { CertManager } from "../tls/certs.ts";
import type { CertStore } from "../tls/certstore.ts";
import { SETTINGS, type SettingDef } from "../settings.ts";
import type { Core } from "./core.ts";
import { claimDeps } from "./domains.ts";
import { checkDue } from "../domains/claims.ts";

export type CertRenewal = {
  manager: CertManager;
  certStore: CertStore;
  listener: RunningListener;
};

export type Reconciling = { reconciler: Reconciler; reconciled: Promise<ReconcileReport | null> };

export type JobDeps = Pick<
  Core,
  | "config"
  | "logger"
  | "repos"
  | "updates"
  | "settings"
  | "db"
  | "domains"
  | "table"
  | "audit"
  | "bus"
> &
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
  if (d.renewal) registerCertRenewal(scheduler, d.renewal, d.domains);
  registerPurges(scheduler, d);
  scheduler.register({
    name: "update-check",
    intervalMs: 86_400_000,
    initialDelayMs: 60_000,
    run: (signal) => d.updates.check(signal),
  });
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
  // Pending claims wait on someone's DNS change; a minute is as soon as it is worth asking.
  const claims = claimDeps(d);
  scheduler.register({
    name: "domain-verify",
    intervalMs: 60_000,
    run: async (signal) => {
      await checkDue(claims, signal);
    },
  });
}

function registerCertRenewal(scheduler: Scheduler, r: CertRenewal, domains: Core["domains"]): void {
  r.certStore.onSwap(() => r.listener.swapCerts());
  // A domain that changes mid-run is caught by running again, not left for the next hour.
  let changed = false;
  domains.onChange(() => {
    changed = true;
    scheduler.trigger("cert-renew").catch(() => {});
  });
  // Hourly because Let's Encrypt allows 5 failed validations per hour.
  scheduler.register({
    name: "cert-renew",
    intervalMs: 3_600_000,
    initialDelayMs: 0,
    run: async (signal) => {
      do {
        changed = false;
        const next = await r.manager.refresh(signal);
        if (next) await r.certStore.swap(next);
      } while (changed && !signal.aborted);
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
      d.repos.userLinks.purge();
    },
  });
  scheduler.register({
    name: "retention",
    intervalMs: 86_400_000,
    initialDelayMs: 300_000,
    run: () => {
      const pruned = prune(d);
      if (Object.values(pruned).some((n) => n > 0)) d.logger.info("pruned old records", pruned);
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

const DAY = 86_400_000;

/** Deletes what is past its retention setting, then lets SQLite refresh its query statistics. */
export function prune(
  d: Pick<JobDeps, "repos" | "settings" | "db">,
  now = Date.now(),
): { events: number; audit: number; previews: number } {
  const days = (def: SettingDef<number>) => d.settings.get(def);
  const before = (n: number) => now - n * DAY;
  const events = days(SETTINGS.retentionEvents);
  const audit = days(SETTINGS.retentionAudit);
  const destroyed = days(SETTINGS.retentionDestroyed);
  const out = {
    events: events > 0 ? d.repos.events.pruneBefore(before(events)) : 0,
    audit: audit > 0 ? d.repos.audit.pruneBefore(before(audit)) : 0,
    previews: destroyed > 0 ? d.repos.previews.purgeDestroyedBefore(before(destroyed)).length : 0,
  };
  d.db.exec("PRAGMA optimize");
  return out;
}
