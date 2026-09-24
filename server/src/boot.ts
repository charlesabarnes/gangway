import type { Host } from "@gangway/shared/domain";
import type { Config } from "./config.ts";
import { DockerClients } from "./docker/client.ts";
import type { ComposeRunner } from "./docker/runner.ts";
import { Logger } from "./logger.ts";
import type { Surface } from "./net/dispatch.ts";
import type { RunningListener } from "./net/listener.ts";
import type { PreviewContext } from "./previews/context.ts";
import { IdempotentDeploys } from "./previews/idempotent.ts";
import type { RouteProbe } from "./previews/probe.ts";
import type { Reconciler } from "./reconcile/reconciler.ts";
import type { ClientSource, ReconcileReport } from "./reconcile/reconciler-types.ts";
import type { Scheduler } from "./scheduler/scheduler.ts";
import { createPreviewContext } from "./boot/context.ts";
import { openCore, type Core } from "./boot/core.ts";
import { createForge } from "./boot/forge.ts";
import { createHttp } from "./boot/http.ts";
import { createIdentity, resolveAdminToken, type Identity } from "./boot/identity.ts";
import { startReconciler, startScheduler } from "./boot/jobs.ts";
import { startNetwork, surfaceEnabledBy } from "./boot/network.ts";
import { createStop } from "./boot/shutdown.ts";
import { resolveCertificates, type AcmeOverrides } from "./boot/tls.ts";

export type BootOverrides = {
  logger?: Logger;
  compose?: ComposeRunner;
  clients?: ClientSource;
  probe?: RouteProbe;
  timings?: Partial<PreviewContext["timings"]>;
  announce?: (text: string) => void;
  acme?: AcmeOverrides;
};

export type Running = {
  listener: RunningListener;
  ctx: PreviewContext;
  adminToken: string;
  setupUrl: string | null;
  origin: (label: string) => string;
  caPath: string | null;
  reconciler: Reconciler;
  scheduler: Scheduler;
  reconciled: Promise<ReconcileReport | null>;
  stop(o?: { graceMs?: number }): Promise<void>;
};

export async function boot(config: Config, o: BootOverrides = {}): Promise<Running> {
  const logger = o.logger ?? new Logger(config.logLevel);
  const announce = o.announce ?? ((t) => console.log(t));
  const { core, seeded, workdirs, sources, sites } = await openCore(config, logger);

  const dockerClients = new DockerClients();
  const previews = createPreviewContext(core, {
    workdirs,
    sources,
    sites,
    dockerClients,
    overrides: o,
  });
  const { ctx } = previews;
  const deploys = new IdempotentDeploys(ctx, core.repos.idempotency);
  const forge = createForge(core, previews);
  const identity = createIdentity(core);
  const adminToken = resolveAdminToken(config.adminToken, announce);

  const shutdown = new AbortController();
  const signal = shutdown.signal;
  const http = createHttp(core, { ...previews, ...forge, deploys, identity, adminToken, signal });

  const domains = [
    ...new Set([core.baseDomain(), core.previewDomain()].flatMap((d) => [`*.${d}`, d])),
  ];
  const certs = await resolveCertificates(core, domains, o.acme);
  const surfaceEnabled = surfaceEnabledBy(core.settings);
  const { hooks } = forge;
  const network = startNetwork({ ...core, ctx, surfaceEnabled, http, hooks, bundle: certs.bundle });

  const reconciling = startReconciler(core, ctx, o.clients ?? dockerClients);
  const { reconciler, reconciled } = reconciling;
  const scheduler = startScheduler({
    ...core,
    ...reconciling,
    ctx,
    deploys,
    sessions: identity.sessions,
    renewal: certs.acme && { acme: certs.acme, domains, ...network },
  });

  const setupUrl = announceStartup({ core, identity, surfaceEnabled, announce, seeded, network });
  const stop = createStop({
    ...core,
    shutdown,
    network,
    scheduler,
    reconciled,
    ctx,
    hooks,
    dockerClients,
  });
  let stopped: Promise<void> | null = null;
  return {
    listener: network.listener,
    ctx,
    adminToken,
    setupUrl,
    origin: core.origin,
    caPath: certs.caPath,
    reconciler,
    scheduler,
    reconciled,
    stop: (o = {}) => (stopped ??= stop(o.graceMs ?? config.shutdownGraceMs)),
  };
}

type StartupNotice = {
  core: Core;
  identity: Identity;
  surfaceEnabled: (s: Surface) => boolean;
  announce: (text: string) => void;
  seeded: Host[];
  network: { listener: RunningListener };
};

function announceStartup(d: StartupNotice): string | null {
  const { config, logger, origin } = d.core;
  // Through announce, not the logger, which would redact the setup link.
  const setupUrl = d.surfaceEnabled("app") ? d.identity.bootstrap.url(origin("app")) : null;
  if (setupUrl)
    d.announce(
      `\n  No accounts exist yet. Create the first admin here (one use, this run only):\n\n    ${setupUrl}\n`,
    );
  if (d.core.repos.users.count() > 0 && config.trustedProxies.length === 0) {
    logger.warn(
      "accounts exist but GANGWAY_TRUSTED_PROXIES is empty; if a reverse proxy sits in front, login rate limits and audit IPs will all be the proxy's",
    );
  }

  logger.info("listening", {
    address: config.listenAddress,
    port: d.network.listener.port,
    baseDomain: d.core.baseDomain(),
    routes: d.core.table.size,
    hosts: d.seeded.map((h) => h.id),
  });
  return setupUrl;
}
