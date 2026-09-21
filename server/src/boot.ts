/**
 * The composition root: the one place that knows about every module, and therefore the
 * one file allowed to import both `app/` and everything beneath it.
 *
 * Order matters and follows §11: load routes and SERVE IMMEDIATELY -- nothing here waits
 * on a Docker daemon, so an unreachable host delays no request.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp, surfaceHandler } from "./app/app.ts";
import { eventRoutes } from "./app/routes/events.ts";
import { hostRoutes } from "./app/routes/hosts.ts";
import { previewRoutes } from "./app/routes/previews.ts";
import { staticTokenVerifier } from "./auth/actor.ts";
import type { Config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { EventsRepo, HostsRepo, PreviewsRepo, RoutesRepo, SqliteSettingsStore } from "./db/repos/index.ts";
import { openDatabase } from "./db/sqlite.ts";
import { DockerClients } from "./docker/client.ts";
import { Reconciler, type ClientSource, type ReconcileReport } from "./reconcile/reconciler.ts";
import { createComposeRunner, type ComposeRunner } from "./docker/runner.ts";
import { EventBus } from "./events/bus.ts";
import { seedHosts } from "./hosts/seed.ts";
import { Logger } from "./logger.ts";
import type { DispatchDeps, Surface } from "./net/dispatch.ts";
import { DEFAULT_LIMITS } from "./net/limits.ts";
import { clientIpOf, startListener, type RunningListener } from "./net/listener.ts";
import { NodeHttpUpstream } from "./net/upstream.ts";
import { DEFAULT_TIMINGS, type PreviewContext } from "./previews/context.ts";
import { PreviewLogs } from "./previews/logs.ts";
import { httpProbe, type RouteProbe } from "./previews/probe.ts";
import { Workdirs } from "./previews/source/workdir.ts";
import { PreviewStates } from "./previews/state.ts";
import { RouteTable } from "./routing/table.ts";
import { SETTINGS, Settings } from "./settings.ts";
import { CertStore } from "./tls/certstore.ts";
import { FileProvider, SelfSignedProvider } from "./tls/provider.ts";
import { publicOriginFor } from "../../shared/src/url.ts";

export type BootOverrides = {
  logger?: Logger;
  compose?: ComposeRunner;
  /** Tests inject this: the default would dial whatever Docker socket the machine has. */
  clients?: ClientSource;
  probe?: RouteProbe;
  timings?: Partial<PreviewContext["timings"]>;
  /** Where the secret-bearing first-run banner goes. NOT the logger: it would redact it. */
  announce?: (text: string) => void;
};

export type Running = {
  listener: RunningListener;
  ctx: PreviewContext;
  adminToken: string;
  origin: (label: string) => string;
  caPath: string | null;
  reconciler: Reconciler;
  /** The boot-time pass (§11 step 2-3). Serving does NOT wait on it; tests do. */
  reconciled: Promise<ReconcileReport | null>;
  stop(): Promise<void>;
};

const MIGRATIONS = resolve(import.meta.dir, "../migrations");

export async function boot(config: Config, o: BootOverrides = {}): Promise<Running> {
  const logger = o.logger ?? new Logger(config.logLevel);
  const announce = o.announce ?? ((t) => console.log(t));
  const stateDir = resolve(config.stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  /* ---- storage */
  const { db, journalMode } = openDatabase({ path: config.databasePath ?? join(stateDir, "gangway.db") });
  const migrated = migrate(db, MIGRATIONS);
  logger.info("database ready", { journalMode, applied: migrated.applied });

  const hosts = new HostsRepo(db);
  const previews = new PreviewsRepo(db);
  const routes = new RoutesRepo(db);
  const settings = new Settings(config.overrides, new SqliteSettingsStore(db));
  const bus = new EventBus(new EventsRepo(db), (e) => logger.warn("event listener threw", { err: e }));
  const table = new RouteTable(routes);
  const states = new PreviewStates(previews, table, bus);
  const baseDomain = () => settings.get(SETTINGS.baseDomain);

  const seeded = seedHosts(config.hosts, hosts);
  for (const h of seeded) {
    if (h.capabilities.includes("preview") && h.capabilities.includes("runner")) {
      logger.warn("host declares both preview and runner capabilities; see spec §9.1 before accepting untrusted PRs", { hostId: h.id });
    }
  }

  /* ---- §11 step 1: routes into memory, before anything else can fail */
  const all = new Map(previews.list({ includeDestroyed: true }).map((p) => [p.id, p]));
  table.hydrate(routes.all().flatMap((route) => {
    const p = all.get(route.previewId);
    return p ? [{ route, project: p.project, visibility: p.visibility, state: p.state }] : [];
  }));
  const workdirs = new Workdirs(stateDir);
  await workdirs.prune();

  /* ---- docker */
  const dockerClients = new DockerClients();
  const compose = o.compose ?? createComposeRunner(dockerClients, (hostId, ok, err) => hosts.setState(hostId, ok ? "ready" : "unreachable", err));

  const ctx: PreviewContext = {
    instance: config.instanceId, env: config.environment,
    origin: { scheme: config.publicScheme, port: config.publicPort },
    baseDomain,
    defaults: () => ({ ttl: settings.get(SETTINGS.defaultTtl), visibility: settings.get(SETTINGS.defaultVisibility) }),
    hosts, previews, table, states, bus, workdirs, compose,
    logs: new PreviewLogs(stateDir),
    probe: o.probe ?? httpProbe,
    logger: logger.child({ mod: "previews" }),
    timings: { ...DEFAULT_TIMINGS, ...o.timings },
    now: Date.now,
    inflight: new Map(), teardowns: new Set(),
  };

  /* ---- auth (§8.1 headless bootstrap) */
  let adminToken = config.adminToken;
  if (!adminToken) {
    adminToken = `gw_${randomBytes(24).toString("base64url")}`;
    announce(`\n  No GANGWAY_ADMIN_TOKEN is set. Generated one for THIS RUN ONLY:\n\n    ${adminToken}\n`);
  }

  /* ---- application surfaces */
  const staticDir = resolve(import.meta.dir, "../../web/dist/browser");
  const app = createApp({
    logger: logger.child({ mod: "app" }),
    verifyToken: staticTokenVerifier(adminToken),
    staticDir: existsSync(staticDir) ? staticDir : undefined,
    health: () => ({ routes: table.size }),
    v1: (api) => {
      hostRoutes(api, hosts);
      eventRoutes(api, bus);
      previewRoutes(api, ctx);
    },
  });

  /* ---- TLS */
  const domains = [`*.${baseDomain()}`, baseDomain()];
  let caPath: string | null = null;
  let bundle;
  if (config.tlsMode === "file") {
    if (!config.tlsCertPath || !config.tlsKeyPath) throw new Error("tlsMode=file needs GANGWAY_TLS_CERT_PATH and GANGWAY_TLS_KEY_PATH");
    bundle = await new FileProvider(config.tlsCertPath, config.tlsKeyPath).ensure(domains);
  } else {
    if (config.tlsMode === "acme") logger.warn("tlsMode=acme is not built yet (T28); serving the dev CA instead");
    const selfSigned = await new SelfSignedProvider(stateDir).ensure(domains);
    caPath = selfSigned.caPath ?? null;
    bundle = selfSigned;
  }

  /* ---- the listener */
  // ONE dial configuration for now: the proxy reaches every upstream the way it reaches
  // the first host's. Per-host dialing arrives with multi-host (Phase 6).
  const first = seeded[0]!;
  const surfaceEnabled = (s: Surface): boolean =>
    s === "app" ? settings.get(SETTINGS.surfacesUi) : s === "mcp" ? settings.get(SETTINGS.surfacesMcp) : true;
  const origin = (label: string) => publicOriginFor(label ? `${label}.${baseDomain()}` : baseDomain(), ctx.origin);

  const deps: DispatchDeps = {
    baseDomain, table, limits: DEFAULT_LIMITS, surfaceEnabled,
    upstream: new NodeHttpUpstream({
      dial: { dial: first.upstream.dial, proxy: first.upstream.proxy },
      limits: DEFAULT_LIMITS, timeoutMs: config.upstreamTimeoutMs, publicPort: config.publicPort,
    }),
    handlers: { app: surfaceHandler(app, "app"), api: surfaceHandler(app, "api") },
    logTailFor: (id) => ctx.logs.tail(id, 50),
    clientIpFor: clientIpOf,
    onProxied: (entry) => table.touch(entry.hostname, Date.now()),
  };

  const listener = startListener({
    hostname: config.listenAddress, port: config.listenPort,
    maxRequestBodySize: config.maxBodyBytes, idleTimeout: 120,
    certStore: new CertStore(bundle), deps,
    onError: (e) => logger.error("listener error", { err: e }),
  });

  // Plain HTTP exists only to say "use HTTPS". It serves nothing.
  const redirect = config.listenHttpPort === null ? null : Bun.serve({
    hostname: config.listenAddress, port: config.listenHttpPort,
    fetch(req) {
      const u = new URL(req.url);
      u.protocol = `${config.publicScheme}:`;
      u.port = String(config.publicPort);
      return Response.redirect(u.toString(), 308);
    },
  });

  // §11 steps 2-3, AFTER the listener is up: "Serve immediately -- do not block on
  // reconciliation." Interrupted pipelines, orphans and moved ports are all its job.
  const reconciler = new Reconciler({
    ctx, routes, clients: o.clients ?? dockerClients,
    logger: logger.child({ mod: "reconcile" }), orphans: config.reconcileOrphans,
  });
  const reconciled = reconciler.run().catch((e) => { logger.error("boot reconciliation failed", { err: e }); return null; });
  reconciler.start(config.reconcileIntervalMs);

  logger.info("listening", { address: config.listenAddress, port: listener.port, baseDomain: baseDomain(), routes: table.size, hosts: seeded.map((h) => h.id) });

  return {
    listener, ctx, adminToken, origin, caPath, reconciler, reconciled,
    async stop() {
      reconciler.stop();
      await reconciled;
      // T29 makes this graceful. For now: stop accepting, cancel pipelines, close.
      redirect?.stop(true);
      listener.stop(true);
      for (const { abort } of ctx.inflight.values()) abort.abort();
      await Promise.allSettled([...ctx.inflight.values()].map((i) => i.done));
      dockerClients.closeAll();
      db.close();
    },
  };
}
