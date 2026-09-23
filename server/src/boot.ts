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
import { githubRoutes } from "./app/routes/github.ts";
import { projectRoutes } from "./app/routes/projects.ts";
import { surfaceRoutes } from "./app/routes/surfaces.ts";
import { McpSurface } from "./app/mcp-surface.ts";
import { oauthRootRoutes, oauthRoutes } from "./app/routes/oauth.ts";
import { OAuthGrantsRepo } from "./db/repos/oauth-grants.ts";
import { ClientMetadataStore } from "./oauth/client-metadata.ts";
import { OAuthServer } from "./oauth/server.ts";
import { Tools } from "./mcp/tools.ts";
import { Uploads } from "./mcp/uploads.ts";
import { settingsRoutes } from "./app/routes/settings.ts";
import { templateRoutes } from "./app/routes/templates.ts";
import { tokenRoutes } from "./app/routes/tokens.ts";
import { userRoutes } from "./app/routes/users.ts";
import { eventRoutes } from "./app/routes/events.ts";
import { hostRoutes } from "./app/routes/hosts.ts";
import { previewRoutes } from "./app/routes/previews.ts";
import { runtimeRoutes, schemaRoutes } from "./app/routes/runtimes.ts";
import { addonRoutes } from "./app/routes/addons.ts";
import { DataBrowser } from "./previews/data/service.ts";
import { Audit } from "./audit/audit.ts";
import { Accounts } from "./auth/accounts.ts";
import { chainVerifiers, staticTokenVerifier, workflowActor } from "./auth/actor.ts";
import { Bootstrap } from "./auth/bootstrap.ts";
import { LoginLimiter } from "./auth/limiter.ts";
import { Passwords } from "./auth/password.ts";
import { entryPassword, passwordState } from "./previews/password.ts";
import { RolePermissions } from "./auth/roles.ts";
import { Sessions } from "./auth/sessions.ts";
import { Tokens } from "./auth/tokens.ts";
import type { Config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import {
  AuditRepo, BuildsRepo, CertificatesRepo, EventsRepo, HostsRepo, IdempotencyRepo, PreviewsRepo, ProjectsRepo, RolesRepo, RoutesRepo, TemplatesRepo,
  SessionsRepo, SqliteSettingsStore, TokensRepo, UsersRepo,
} from "./db/repos/index.ts";
import { openDatabase } from "./db/sqlite.ts";
import { DockerClients } from "./docker/client.ts";
import { Reconciler, type ClientSource, type ReconcileReport } from "./reconcile/reconciler.ts";
import { createComposeRunner, type ComposeRunner } from "./docker/runner.ts";
import { EventBus } from "./events/bus.ts";
import { GitHubApp } from "./forge/github/app.ts";
import { GitHubForge } from "./forge/github/forge.ts";
import { ManifestStates } from "./forge/github/manifest.ts";
import { Hooks } from "./forge/hooks.ts";
import { PrPreviews } from "./forge/pr-previews.ts";
import { seedHosts } from "./hosts/seed.ts";
import { flushLastSeen, sweepExpired } from "./scheduler/jobs.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { Logger } from "./logger.ts";
import type { DispatchDeps, Surface } from "./net/dispatch.ts";
import { DEFAULT_LIMITS } from "./net/limits.ts";
import { PreviewGate, loadOrCreateGateKey, safePath } from "./net/gate.ts";
import { clientIpOf, startListener, type RunningListener } from "./net/listener.ts";
import { clientIpResolver } from "./net/trustedproxy.ts";
import { wakingPage } from "./net/errorpages.ts";
import { NodeHttpUpstream, PerHostUpstream } from "./net/upstream.ts";
import { DEFAULT_TIMINGS, type PreviewContext } from "./previews/context.ts";
import { PolicyResolver } from "./previews/policy.ts";
import { Pulls } from "./projects/pulls.ts";
import { GitHubOidc } from "./auth/oidc.ts";
import { TRIGGERS, type Trigger } from "../../shared/src/domain.ts";
import { deploy, urlsFor } from "./previews/deploy.ts";
import { destroy } from "./previews/destroy.ts";
import { IdempotentDeploys } from "./previews/idempotent.ts";
import { PreviewLogs } from "./previews/logs.ts";
import { httpProbe, type RouteProbe } from "./previews/probe.ts";
import { Workdirs } from "./previews/source/workdir.ts";
import { SourceStore } from "./previews/source/store.ts";
import { Waker, sweepIdle } from "./previews/sleep.ts";
import { PreviewStates } from "./previews/state.ts";
import { SecretBox, loadOrCreateSecretsKey } from "./secrets/box.ts";
import { createHmac } from "node:crypto";
import { Secrets } from "./secrets/secrets.ts";
import { secretRoutes } from "./app/routes/secrets.ts";
import { githubFullName } from "./forge/github/webhook.ts";
import { RouteTable } from "./routing/table.ts";
import { SETTINGS, Settings } from "./settings.ts";
import { drain, sleep } from "./util/async.ts";
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
    return p ? [{ route, hostId: p.hostId, project: p.project, visibility: p.visibility, state: p.state, password: entryPassword(previews.passwordOf(p.id)), passwordLogin: p.passwordLogin }] : [];
  }));
  const workdirs = new Workdirs(stateDir);
  await workdirs.prune();
  // ADR-0015: a kept upload whose preview is gone -- destroyed, or its row lost -- goes too.
  const sources = new SourceStore(stateDir);
  for (const id of await sources.ids()) {
    const p = all.get(id);
    if (!p || p.state === "destroyed") await sources.remove(id);
  }

  const builds = new BuildsRepo(db);
  const orphanedBuilds = builds.cancelRunning();
  if (orphanedBuilds > 0) logger.info("marked builds interrupted by the last shutdown as cancelled", { builds: orphanedBuilds });

  /* ---- docker */
  const dockerClients = new DockerClients();
  const compose = o.compose ?? createComposeRunner(dockerClients, (hostId, ok, err) => hosts.setState(hostId, ok ? "ready" : "unreachable", err));

  /* ---- ADR-0013/0014: which project a deploy belongs to and which template it follows.
     Named by the request, else the project whose repository the source is: a PR by full
     name, a git deploy by the name in its clone URL; images and tarballs have none. */
  const projects = new ProjectsRepo(db);
  const templates = new TemplatesRepo(db);
  const triggerDefault = (t: Trigger) => settings.get(t === "pr" ? SETTINGS.templatePr : t === "api" ? SETTINGS.templateApi : SETTINGS.templateManual);
  const policy = new PolicyResolver({
    templates,
    project: (ref) => projects.find(ref),
    projectForSource: (source) => {
      const full = source.kind === "pr" ? source.repo : source.kind === "pushed" ? source.pr.repo : source.kind === "git" ? githubFullName(source.repo) : null;
      return full ? projects.getByFullName("github", full) : undefined;
    },
    defaultFor: triggerDefault,
    logger: logger.child({ mod: "policy" }),
  });

  const previewPasswords = new Passwords({ ln: 14 });
  const ctx: PreviewContext = {
    instance: config.instanceId, env: config.environment,
    origin: { scheme: config.publicScheme, port: config.publicPort },
    baseDomain, policy,
    hosts, previews, table, states, bus, workdirs, compose,
    logs: new PreviewLogs(stateDir),
    probe: o.probe ?? httpProbe,
    logger: logger.child({ mod: "previews" }),
    timings: { ...DEFAULT_TIMINGS, ...o.timings },
    now: Date.now,
    inflight: new Map(), teardowns: new Set(),
    builds, audit, sources,
    privateAvailable: () => settings.get(SETTINGS.surfacesUi),
    // ADR-0023: cheaper than a login's scrypt (these guard previews, not accounts) and its
    // own semaphore, so a burst of password forms never queues an operator's login.
    passwords: {
      passwords: previewPasswords, defaultMode: () => settings.get(SETTINGS.previewPasswordMode),
      sharedSet: () => settings.get(SETTINGS.previewPasswordShared) !== null,
      loginDefault: () => settings.get(SETTINGS.previewPasswordLogin),
    },
  };

  const deploys = new IdempotentDeploys(ctx, new IdempotencyRepo(db));

  /* ---- pull requests (ADR-0011). Credentials are read from settings on every use. */
  const secretsKey = loadOrCreateSecretsKey(stateDir);
  const secrets = new Secrets(projects, settingsStore, new SecretBox(secretsKey), audit);
  // ADR-0017: an add-on's password, the same on every rebuild (so compose never recreates the
  // database) and stored nowhere. Losing secrets.key changes it; the volume keeps the old one.
  ctx.addonSecret = (previewId, addon) => createHmac("sha256", secretsKey).update(`gangway-addon\0${previewId}\0${addon}`).digest("base64url").slice(0, 32);
  // ADR-0012: the global map, plus the repository's when the deploy has one, at the clearance the pipeline resolved.
  ctx.secretsFor = (repoId, clearance) => secrets.valuesFor(repoId, clearance);
  const githubApp = new GitHubApp({
    credentials: () => ({ appId: settings.get(SETTINGS.githubAppId), privateKey: settings.get(SETTINGS.githubPrivateKey) }),
    log: logger.child({ mod: "github" }),
  });
  const forge = new GitHubForge({ app: githubApp, webhookSecret: () => settings.get(SETTINGS.githubWebhookSecret) });
  const prPreviews = new PrPreviews({
    forge, repos: projects, instance: config.instanceId, logger: logger.child({ mod: "pr" }), policy,
    secretsFor: (repo, clearance) => secrets.valuesFor(repo.id, clearance),
    previews: {
      deploy: (input) => deploy(ctx, input),
      destroy: (id, actor) => destroy(ctx, id, actor),
      findPullRequest: (repo, number) => ctx.previews.findPullRequest(repo, number),
      urls: (id) => urlsFor(ctx, id),
      forgeRefs: (id) => ctx.previews.forgeRefs(id),
      setForgeRefs: (id, refs) => ctx.previews.setForgeRefs(id, refs),
    },
    logUrlFor: (id) => (settings.get(SETTINGS.surfacesUi) ? `${publicOriginFor(`app.${baseDomain()}`, ctx.origin)}/previews/${id}` : undefined),
  });
  const hooks = new Hooks({ forge, service: prPreviews, logger: logger.child({ mod: "hooks" }) });

  /* ---- accounts (§8.1). The matrix is loaded once and kept write-through (ADR-0009). */
  const users = new UsersRepo(db);
  const rolesRepo = new RolesRepo(db);
  const roles = new RolePermissions(rolesRepo, audit);
  const sessions = new Sessions(new SessionsRepo(db), roles);
  /* ---- ADR-0020: the OAuth 2.1 authorization server for MCP clients. Issuer `app`, resource `mcp`. */
  const mcpOrigin = () => publicOriginFor(`mcp.${baseDomain()}`, ctx.origin);
  const oauthGrants = new OAuthGrantsRepo(db);
  const oauth = new OAuthServer({
    grants: oauthGrants, clients: new ClientMetadataStore(), roles, audit,
    issuer: () => publicOriginFor(`app.${baseDomain()}`, ctx.origin), resource: mcpOrigin,
  });
  const accounts = new Accounts({
    db, users, roles: rolesRepo, sessions, audit,
    passwords: new Passwords(), limiter: new LoginLimiter(),
    onCredentialsRevoked: (userId) => oauth.revokeAllFor(userId),
  });
  const tokensRepo = new TokensRepo(db);
  const tokens = new Tokens(tokensRepo, roles, audit);
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
    // ADR-0023: the shared password applies only while the default says `shared`.
    sharedPassword: () => (settings.get(SETTINGS.previewPasswordMode) === "shared" ? settings.get(SETTINGS.previewPasswordShared) : null),
    passwords: previewPasswords,
    // Per source and per preview; a preview's counter locks after 10 misses, doubling to 15 minutes.
    limiter: new LoginLimiter({ emailFree: 10 }),
    loginDefault: () => settings.get(SETTINGS.previewPasswordLogin),
    onPasswordFailure: (entry, clientIp, reason) => logger.warn("preview password refused", { previewId: entry.previewId, host: entry.hostname, clientIp, reason }),
  });

  /* ---- ADR-0014: pull requests from a project's own workflow. The workflow's OIDC
     audience is our public API origin, so a token minted for anything else is refused. */
  const apiOrigin = () => publicOriginFor(`api.${baseDomain()}`, ctx.origin);
  const oidc = new GitHubOidc({ audience: apiOrigin, logger: logger.child({ mod: "oidc" }) });
  const pulls = new Pulls({
    projects,
    previews: {
      deploy: (input) => deploy(ctx, input),
      destroy: (id, actor) => destroy(ctx, id, actor),
      findPullRequest: (repo, number) => ctx.previews.findPullRequest(repo, number),
    },
  });

  /* ---- application surfaces */
  const auth = {
    // Database tokens first: they are the common case. The env token stays, always (§8.1).
    // Last: a GitHub Actions run's OIDC token (ADR-0014), confined to its project's pull routes.
    verifyToken: chainVerifiers(tokens.verify, staticTokenVerifier(adminToken), async (presented) => {
      const claims = await oidc.verify(presented);
      return claims ? workflowActor(claims) : null;
    }),
    resolveSession: (secret: string) => sessions.resolve(secret)?.actor ?? null,
    // What a browser on this Host sends as `Origin`. From the PUBLIC scheme and port, never
    // the listener's: behind a reverse proxy they differ, and the browser only knows one.
    originFor: (host: string) => publicOriginFor(normalizeHost(host) ?? "", ctx.origin),
  };
  /* ---- §10.2 the MCP surface (ADR-0019): bearer only. A workflow's OIDC token is not in its chain. */
  // ADR-0021: an agent's shell PUTs a tarball here, and `deploy` builds exactly those bytes.
  const uploads = new Uploads({ dir: join(stateDir, "uploads"), url: (id) => `${mcpOrigin()}/uploads/${id}` });
  const mcp = new McpSurface({
    tools: new Tools({ ctx, deploys, uploads, logger: logger.child({ mod: "mcp" }) }),
    uploads,
    // OAuth access tokens are good HERE and nowhere else: `/v1`'s chain does not know them.
    verifyToken: chainVerifiers(tokens.verify, staticTokenVerifier(adminToken), oauth.verify),
    logger: logger.child({ mod: "mcp" }),
    // No UI, no consent page: MCP is then bearer-only and advertises no OAuth.
    oauth: { available: () => settings.get(SETTINGS.surfacesUi), resource: mcpOrigin, resourceMetadata: () => oauth.resourceMetadata() },
  });
  const mcpOn = () => settings.get(SETTINGS.surfacesMcp);

  const staticDir = resolve(import.meta.dir, "../../web/dist/browser");
  const app = createApp({
    logger: logger.child({ mod: "app" }),
    ...auth,
    staticDir: existsSync(staticDir) ? staticDir : undefined,
    health: () => ({ routes: table.size }),
    draining,
    root: (root) => oauthRootRoutes(root, { oauth, enabled: mcpOn }),
    v1: (api) => {
      hostRoutes(api, hosts);
      eventRoutes(api, bus, { signal: shutdown.signal });
      previewRoutes(api, ctx, deploys, { signal: shutdown.signal });
      runtimeRoutes(api);
      addonRoutes(api, new DataBrowser(ctx));
      auditRoutes(api, auditRepo);
      tokenRoutes(api, tokens);
      userRoutes(api, accounts);
      roleRoutes(api, roles);
      settingsRoutes(api, settings, audit, templates, (plain) => previewPasswords.hash(plain));
      oauthRoutes(api, { oauth, enabled: mcpOn });
      surfaceRoutes(api, {
        settings, audit, apiOrigin,
        hasActiveAdmin: () => tokensRepo.hasActiveAdmin(Date.now()),
        mcpOrigin,
        onMcpDisabled: () => mcp.dropAll(),
      });
      projectRoutes(api, {
        projects, audit, secrets, templates, pulls, apiOrigin,
        wire: (p) => ({ ...p, ...passwordState(ctx.passwords, p), urls: urlsFor(ctx, p.id) }),
      });
      templateRoutes(api, { templates, hosts, audit, namedByTrigger: (id) => TRIGGERS.filter((t) => triggerDefault(t) === id) });
      secretRoutes(api, secrets);
      githubRoutes(api, { app: githubApp, settings, states: new ManifestStates(), audit, baseDomain, originFor: (label) => publicOriginFor(`${label}.${baseDomain()}`, ctx.origin) });
    },
    publicV1: (pub) => {
      authRoutes(pub, {
        auth, accounts, bootstrap, roles, sessionMaxAgeSec: Math.floor(sessions.timings.absoluteMs / 1000),
        gate: {
          lookup: (host) => table.lookup(host), issueTicket: (e, o) => gate.issueTicket(e, o),
          gateable: (host) => { const e = table.lookup(host); return e ? gate.gateable(e) : { private: false, passwordSkippable: false }; },
          originFor: (host) => publicOriginFor(host, ctx.origin), safePath,
        },
      });
      schemaRoutes(pub);
    },
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

  // ADR-0012: the request that finds a preview asleep starts the wake and waits a little.
  const waker = new Waker(ctx, logger.child({ mod: "wake" }));
  const deps: DispatchDeps = {
    baseDomain, table, limits: DEFAULT_LIMITS, surfaceEnabled,
    visibilityGate: gate.handle,
    wake: async (entry) => {
      const woke = await Promise.race([
        waker.wake(entry.previewId).then(() => true, () => false),
        sleep(config.wakeWaitMs).then(() => false),
      ]);
      return woke ? null : wakingPage(entry.hostname);
    },
    // Each host is dialed its own way: one directly, another through a SOCKS tunnel.
    upstream: new PerHostUpstream((hostId) => {
      const host = hosts.get(hostId);
      return host ? new NodeHttpUpstream({
        dial: { dial: host.upstream.dial, proxy: host.upstream.proxy },
        limits: DEFAULT_LIMITS, timeoutMs: config.upstreamTimeoutMs, publicPort: config.publicPort,
      }) : null;
    }),
    handlers: { app: surfaceHandler(app, "app"), api: surfaceHandler(app, "api"), hooks: hooks.handler(), mcp: mcp.handler() },
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
  scheduler.register({
    name: "idle-sleep", intervalMs: config.idleSweepIntervalMs,
    run: (signal) => sweepIdle(ctx, logger.child({ job: "idle-sleep" }), signal),
  });
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
  // ADR-0020: grants past their end, or revoked, a week ago (the Account page stops showing them at once).
  scheduler.register({ name: "oauth-purge", intervalMs: 3_600_000, run: () => { oauthGrants.purge(Date.now() - 7 * 86_400_000); } });
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
    const drained = await drain(() => listener.pending().requests === 0 && ctx.inflight.size === 0 && hooks.inflight === 0, { timeoutMs: left() });

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
