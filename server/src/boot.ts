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
import { auditRoutes } from "./app/routes/audit.ts";
import { authRoutes } from "./app/routes/auth.ts";
import { roleRoutes } from "./app/routes/roles.ts";
import { settingsRoutes } from "./app/routes/settings.ts";
import { tokenRoutes } from "./app/routes/tokens.ts";
import { userRoutes } from "./app/routes/users.ts";
import { eventRoutes } from "./app/routes/events.ts";
import { hostRoutes } from "./app/routes/hosts.ts";
import { previewRoutes } from "./app/routes/previews.ts";
import { Audit } from "./audit/audit.ts";
import { Accounts } from "./auth/accounts.ts";
import { chainVerifiers, staticTokenVerifier } from "./auth/actor.ts";
import { Bootstrap } from "./auth/bootstrap.ts";
import { LoginLimiter } from "./auth/limiter.ts";
import { Passwords } from "./auth/password.ts";
import { RolePermissions } from "./auth/roles.ts";
import { Sessions } from "./auth/sessions.ts";
import { Tokens } from "./auth/tokens.ts";
import type { Config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import {
  AuditRepo, BuildsRepo, CertificatesRepo, EventsRepo, HostsRepo, IdempotencyRepo, PreviewsRepo, RolesRepo, RoutesRepo,
  SessionsRepo, SqliteSettingsStore, TokensRepo, UsersRepo,
} from "./db/repos/index.ts";
import { openDatabase } from "./db/sqlite.ts";
import { DockerClients } from "./docker/client.ts";
import { Reconciler, type ClientSource, type ReconcileReport } from "./reconcile/reconciler.ts";
import { createComposeRunner, type ComposeRunner } from "./docker/runner.ts";
import { EventBus } from "./events/bus.ts";
import { seedHosts } from "./hosts/seed.ts";
import { flushLastSeen, sweepExpired } from "./scheduler/jobs.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { Logger } from "./logger.ts";
import type { DispatchDeps, Surface } from "./net/dispatch.ts";
import { DEFAULT_LIMITS } from "./net/limits.ts";
import { PreviewGate, loadOrCreateGateKey, safePath } from "./net/gate.ts";
import { clientIpOf, startListener, type RunningListener } from "./net/listener.ts";
import { clientIpResolver } from "./net/trustedproxy.ts";
import { NodeHttpUpstream, PerHostUpstream } from "./net/upstream.ts";
import { DEFAULT_TIMINGS, type PreviewContext } from "./previews/context.ts";
import { IdempotentDeploys } from "./previews/idempotent.ts";
import { PreviewLogs } from "./previews/logs.ts";
import { httpProbe, type RouteProbe } from "./previews/probe.ts";
import { Workdirs } from "./previews/source/workdir.ts";
import { PreviewStates } from "./previews/state.ts";
import { RouteTable } from "./routing/table.ts";
import { SETTINGS, Settings } from "./settings.ts";
import { drain } from "./util/async.ts";
import { AcmeProvider, type AcmeConnect } from "./tls/acme.ts";
import { CertStore } from "./tls/certstore.ts";
import { CloudflareDnsProvider } from "./tls/dns/cloudflare.ts";
import { ManualDnsProvider } from "./tls/dns/manual.ts";
import type { DnsProvider } from "./tls/dns/provider.ts";
import { FileProvider, SelfSignedProvider } from "./tls/provider.ts";
import { normalizeHost } from "../../shared/src/hostname.ts";
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
  /** tlsMode=acme only. Tests and the Pebble check supply their own DNS and ACME client. */
  acme?: { dns?: DnsProvider; connect?: AcmeConnect };
};

export type Running = {
  listener: RunningListener;
  ctx: PreviewContext;
  adminToken: string;
  /** §8.1 first run: where the first admin is created. null once any account exists. */
  setupUrl: string | null;
  origin: (label: string) => string;
  caPath: string | null;
  reconciler: Reconciler;
  scheduler: Scheduler;
  /** The boot-time pass (§11 step 2-3). Serving does NOT wait on it; tests do. */
  reconciled: Promise<ReconcileReport | null>;
  /**
   * Graceful: stop taking control-plane work, let in-flight requests and pipelines finish
   * for up to `graceMs` (default `config.shutdownGraceMs`), then close what is left.
   * Previews keep being proxied until the very end. Idempotent.
   */
  stop(o?: { graceMs?: number }): Promise<void>;
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
  const settingsStore = new SqliteSettingsStore(db);
  const settings = new Settings(config.overrides, settingsStore);
  const bus = new EventBus(new EventsRepo(db), (e) => logger.warn("event listener threw", { err: e }));
  const table = new RouteTable(routes);
  const states = new PreviewStates(previews, table, bus);
  const baseDomain = () => settings.get(SETTINGS.baseDomain);
  const auditRepo = new AuditRepo(db);
  const audit = new Audit(auditRepo, logger.child({ mod: "audit" }));

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
    return p ? [{ route, hostId: p.hostId, project: p.project, visibility: p.visibility, state: p.state }] : [];
  }));
  const workdirs = new Workdirs(stateDir);
  await workdirs.prune();

  const builds = new BuildsRepo(db);
  const orphanedBuilds = builds.cancelRunning();
  if (orphanedBuilds > 0) logger.info("marked builds interrupted by the last shutdown as cancelled", { builds: orphanedBuilds });

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
    builds, audit,
    privateAvailable: () => settings.get(SETTINGS.surfacesUi),
  };

  const deploys = new IdempotentDeploys(ctx, new IdempotencyRepo(db));

  /* ---- accounts (§8.1). The matrix is loaded once and kept write-through (ADR-0009). */
  const users = new UsersRepo(db);
  const rolesRepo = new RolesRepo(db);
  const roles = new RolePermissions(rolesRepo, audit);
  const sessions = new Sessions(new SessionsRepo(db), roles);
  const accounts = new Accounts({
    db, users, roles: rolesRepo, sessions, audit,
    passwords: new Passwords(), limiter: new LoginLimiter(),
  });
  const tokens = new Tokens(new TokensRepo(db), roles, audit);
  const bootstrap = new Bootstrap(() => users.count());

  /* ---- headless bootstrap (§8.1): the env token works whether or not anyone has an account */
  let adminToken = config.adminToken;
  if (!adminToken) {
    adminToken = `gw_${randomBytes(24).toString("base64url")}`;
    announce(`\n  No GANGWAY_ADMIN_TOKEN is set. Generated one for THIS RUN ONLY:\n\n    ${adminToken}\n`);
  }

  /* ---- shutdown state, read by the surfaces built below */
  const shutdown = new AbortController();
  const draining = () => shutdown.signal.aborted;

  /* ---- §8.3 private previews. The session never leaves `app`; a preview gets its own cookie. */
  const gate = new PreviewGate({
    key: loadOrCreateGateKey(settingsStore),
    appOrigin: () => publicOriginFor(`app.${baseDomain()}`, ctx.origin),
  });

  /* ---- application surfaces */
  const auth = {
    // Database tokens first: they are the common case. The env token stays, always (§8.1).
    verifyToken: chainVerifiers(tokens.verify, staticTokenVerifier(adminToken)),
    resolveSession: (secret: string) => sessions.resolve(secret)?.actor ?? null,
    // What a browser on this Host sends as `Origin`. From the PUBLIC scheme and port, never
    // the listener's: behind a reverse proxy they differ, and the browser only knows one.
    originFor: (host: string) => publicOriginFor(normalizeHost(host) ?? "", ctx.origin),
  };
  const staticDir = resolve(import.meta.dir, "../../web/dist/browser");
  const app = createApp({
    logger: logger.child({ mod: "app" }),
    ...auth,
    staticDir: existsSync(staticDir) ? staticDir : undefined,
    health: () => ({ routes: table.size }),
    draining,
    v1: (api) => {
      hostRoutes(api, hosts);
      eventRoutes(api, bus, { signal: shutdown.signal });
      previewRoutes(api, ctx, deploys, { signal: shutdown.signal });
      auditRoutes(api, auditRepo);
      tokenRoutes(api, tokens);
      userRoutes(api, accounts);
      roleRoutes(api, roles);
      settingsRoutes(api, settings, audit);
    },
    publicV1: (pub) => authRoutes(pub, {
      auth, accounts, bootstrap, roles, sessionMaxAgeSec: Math.floor(sessions.timings.absoluteMs / 1000),
      gate: { lookup: (host) => table.lookup(host), issueTicket: (e) => gate.issueTicket(e), originFor: (host) => publicOriginFor(host, ctx.origin), safePath },
    }),
  });

  /* ---- TLS */
  const domains = [`*.${baseDomain()}`, baseDomain()];
  let caPath: string | null = null;
  let bundle;
  let acmeProvider: AcmeProvider | null = null;
  if (config.tlsMode === "file") {
    if (!config.tlsCertPath || !config.tlsKeyPath) throw new Error("tlsMode=file needs GANGWAY_TLS_CERT_PATH and GANGWAY_TLS_KEY_PATH");
    bundle = await new FileProvider(config.tlsCertPath, config.tlsKeyPath).ensure(domains);
  } else if (config.tlsMode === "acme") {
    const tlsLog = logger.child({ mod: "tls" });
    const token = settings.get(SETTINGS.cloudflareApiToken);
    const zoneId = settings.get(SETTINGS.cloudflareZoneId);
    acmeProvider = new AcmeProvider({
      directoryUrl: settings.get(SETTINGS.acmeDirectoryUrl), email: settings.get(SETTINGS.acmeEmail),
      // No Cloudflare token: print the records and wait for a human. Slow, but it works on any DNS host.
      dns: o.acme?.dns ?? (token ? new CloudflareDnsProvider({ apiToken: token, ...(zoneId ? { zoneId } : {}), log: tlsLog }) : new ManualDnsProvider({ log: tlsLog })),
      certs: new CertificatesRepo(db), store: settingsStore, logger: tlsLog,
      ...(o.acme?.connect ? { connect: o.acme.connect } : {}),
    });
    // §11 "serve immediately" applies to certificates too: what is stored is served now;
    // with nothing stored, the dev CA stands in until the first order completes (a minute
    // or two), and the `cert-renew` job swaps the real one in without a restart.
    const stored = acmeProvider.load(domains);
    if (stored) {
      bundle = stored;
    } else {
      tlsLog.warn("no usable ACME certificate stored yet; serving the dev CA until the first order completes", { domains });
      const interim = await new SelfSignedProvider(stateDir).ensure(domains);
      caPath = interim.caPath ?? null;
      bundle = interim;
    }
  } else {
    const selfSigned = await new SelfSignedProvider(stateDir).ensure(domains);
    caPath = selfSigned.caPath ?? null;
    bundle = selfSigned;
  }

  /* ---- the listener */
  const surfaceEnabled = (s: Surface): boolean =>
    s === "app" ? settings.get(SETTINGS.surfacesUi) : s === "mcp" ? settings.get(SETTINGS.surfacesMcp) : true;
  const origin = (label: string) => publicOriginFor(label ? `${label}.${baseDomain()}` : baseDomain(), ctx.origin);

  // Throws at boot on a malformed entry: a typo must not quietly mean "trust nobody".
  const resolveClientIp = clientIpResolver(config.trustedProxies);
  if (config.trustedProxies.length > 0) logger.info("trusting X-Forwarded-For from reverse proxies", { trustedProxies: config.trustedProxies });

  const deps: DispatchDeps = {
    baseDomain, table, limits: DEFAULT_LIMITS, surfaceEnabled,
    visibilityGate: gate.check,
    // Each host is dialed its own way: one directly, another through a SOCKS tunnel.
    upstream: new PerHostUpstream((hostId) => {
      const host = hosts.get(hostId);
      return host ? new NodeHttpUpstream({
        dial: { dial: host.upstream.dial, proxy: host.upstream.proxy },
        limits: DEFAULT_LIMITS, timeoutMs: config.upstreamTimeoutMs, publicPort: config.publicPort,
      }) : null;
    }),
    handlers: { app: surfaceHandler(app, "app"), api: surfaceHandler(app, "api") },
    logTailFor: (id) => ctx.logs.tail(id, 50),
    clientIpFor: (req) => resolveClientIp(clientIpOf(req), req.headers.get("x-forwarded-for")),
    onProxied: (entry) => table.touch(entry.hostname, Date.now()),
  };

  const certStore = new CertStore(bundle);
  const listener = startListener({
    hostname: config.listenAddress, port: config.listenPort,
    maxRequestBodySize: config.maxBodyBytes, idleTimeout: 120,
    certStore, deps,
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

  // Everything periodic lives on the one scheduler: no overlap, jitter, and a stop()
  // that waits -- so nothing below is still touching the database when it closes.
  const scheduler = new Scheduler({ logger: logger.child({ mod: "scheduler" }) });
  // Periodic passes double as the reconnect detector (§11): each one re-probes every host.
  scheduler.register({ name: "reconcile", intervalMs: config.reconcileIntervalMs, run: () => reconciler.run() });
  scheduler.register({
    name: "ttl-sweep", intervalMs: config.ttlSweepIntervalMs,
    // The first sweep waits for the boot reconcile: that is what learns which hosts are reachable.
    run: async (signal) => { await reconciled; await sweepExpired(ctx, logger.child({ mod: "ttl" }), signal); },
    initialDelayMs: 0,
  });
  scheduler.register({ name: "lastseen-flush", intervalMs: config.lastSeenFlushIntervalMs, run: () => flushLastSeen(ctx) });
  if (acmeProvider) {
    const provider = acmeProvider;
    certStore.onSwap(() => listener.swapCerts());
    // Hourly, and cheap when nothing is due. One failed order an hour stays far inside
    // Let's Encrypt's failed-validation limit (5/hour); a tighter retry loop would not.
    scheduler.register({
      name: "cert-renew", intervalMs: 3_600_000, initialDelayMs: 0,
      run: async (signal) => {
        const next = await provider.renewIfDue(domains, signal);
        if (next) await certStore.swap(next);
      },
    });
  }
  scheduler.register({ name: "idempotency-purge", intervalMs: 3_600_000, run: () => deploys.purge() });
  // Expired sessions are already refused; this only reclaims the rows.
  scheduler.register({ name: "session-purge", intervalMs: 3_600_000, run: () => { sessions.purge(); } });
  scheduler.start();

  // §8.1 first run. AFTER the listener is up, so the link works the moment it is read, and
  // through `announce`: the logger would redact it. Not printed when the UI is off -- there
  // is no page to open, and the env admin token is the way in.
  const setupUrl = surfaceEnabled("app") ? bootstrap.url(origin("app")) : null;
  if (setupUrl) announce(`\n  No accounts exist yet. Create the first admin here (one use, this run only):\n\n    ${setupUrl}\n`);
  // Behind a reverse proxy with nobody trusted, every visitor has the PROXY's address: one
  // person failing to log in would lock out everyone, and the audit log would name nobody.
  if (users.count() > 0 && config.trustedProxies.length === 0) {
    logger.warn("accounts exist but GANGWAY_TRUSTED_PROXIES is empty; if a reverse proxy sits in front, login rate limits and audit IPs will all be the proxy's");
  }

  logger.info("listening", { address: config.listenAddress, port: listener.port, baseDomain: baseDomain(), routes: table.size, hosts: seeded.map((h) => h.id) });

  let stopped: Promise<void> | null = null;
  const stop = async (graceMs: number): Promise<void> => {
    const began = Date.now();
    // 1. No new control-plane work: /v1 answers 503, /healthz goes unready, SSE streams
    //    end (their clients resume by Last-Event-ID). No new connections either -- but
    //    requests on connections that already exist, previews above all, are still served.
    shutdown.abort();
    redirect?.stop(true);
    listener.stop(false);

    // 2. Let what is running finish: scheduled jobs, requests, deploys. One shared deadline.
    const left = () => Math.max(0, graceMs - (Date.now() - began));
    await scheduler.stop(graceMs);
    await reconciled;
    const drained = await drain(() => listener.pending().requests === 0 && ctx.inflight.size === 0, { timeoutMs: left() });

    // 3. Out of patience. An aborted pipeline leaves its row `building`/`starting`, which
    //    is exactly what the next boot's reconciler rescues (§11) -- from evidence.
    const cut = { requests: listener.pending().requests, webSockets: listener.pending().webSockets, pipelines: ctx.inflight.size };
    for (const { abort } of ctx.inflight.values()) abort.abort();
    await Promise.allSettled([...ctx.inflight.values()].map((i) => i.done));
    listener.stop(true);

    try { flushLastSeen(ctx); } catch (e) { logger.warn("final lastSeen flush failed", { err: e }); }
    dockerClients.closeAll();
    logger.info("stopped", { drained, ms: Date.now() - began, ...(drained ? {} : { cut }) });
    db.close();
  };

  return {
    listener, ctx, adminToken, setupUrl, origin, caPath, reconciler, scheduler, reconciled,
    stop: (o = {}) => (stopped ??= stop(o.graceMs ?? config.shutdownGraceMs)),
  };
}
