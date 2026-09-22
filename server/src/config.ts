/**
 * Process-level configuration: env and file. Anything here is a CONFIG OVERRIDE and
 * therefore outranks the database (§10.5 precedence). Operator-tunable values that should
 * be editable from the UI live in settings.ts instead.
 *
 * §13: "Never assume ownership of :80 and :443. Listen address and ports are
 * configuration, not constants."
 */
import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);

export const HostConfigSchema = z.object({
  id: z.string().min(1).default("local"),
  name: z.string().min(1).default("local"),
  /** How we talk to the daemon. */
  dockerHost: z.string().min(1).default("unix:///var/run/docker.sock"),
  /** Guard: assert `docker info`.Name matches before doing anything (see docker/guard.ts). */
  expectName: z.string().optional(),
  capabilities: z.array(z.enum(["preview", "runner"])).default(["preview"]),
  /** The IP dockerd binds published ports to. */
  publishBind: z.string().default("127.0.0.1"),
  /** How the proxy reaches those published ports. Dev uses socks5 over the SSH tunnel. */
  upstreamDial: z.enum(["direct", "socks5"]).default("direct"),
  upstreamAddress: z.string().default("127.0.0.1"),
  upstreamProxy: z.string().optional(),
  portRangeStart: port.default(31000),
  portRangeEnd: port.default(31499),
});
export type HostConfig = z.infer<typeof HostConfigSchema>;

export const ConfigSchema = z.object({
  /**
   * Written into every container label (§4.1). Two gangway installations can share one
   * daemon; these are how each tells its containers from the other's.
   */
  instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default("default"),
  environment: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default("dev"),

  stateDir: z.string().default("./state"),
  databasePath: z.string().optional(),

  listenAddress: z.string().default("::"),
  listenPort: port.default(8443),
  /** null disables the plain-HTTP redirect listener entirely. */
  listenHttpPort: port.nullable().default(8080),

  publicScheme: z.enum(["http", "https"]).default("https"),
  publicPort: port.default(8443),

  maxBodyBytes: z.coerce.number().int().positive().default(512 * 1024 * 1024),
  upstreamTimeoutMs: z.coerce.number().int().positive().default(30_000),
  previewInflightCap: z.coerce.number().int().positive().default(256),

  /** §11. Each pass also re-probes every host, so this bounds reconnect detection. 0 disables. */
  reconcileIntervalMs: z.coerce.number().int().min(0).default(60_000),
  /** `report` logs what the reconciler WOULD stop and stops nothing. */
  reconcileOrphans: z.enum(["stop", "report"]).default("stop"),

  /** How often expired previews are destroyed. 0 disables the sweep (TTLs are then advisory). */
  ttlSweepIntervalMs: z.coerce.number().int().min(0).default(60_000),
  idleSweepIntervalMs: z.coerce.number().int().min(0).default(60_000),
  /** How long a request waits for a wake before it gets the 202 page (§6.3: ~3 s). */
  wakeWaitMs: z.coerce.number().int().min(0).default(3_000),
  /** How often in-memory "last visited" marks reach SQLite. Also flushed once at shutdown. */
  lastSeenFlushIntervalMs: z.coerce.number().int().min(0).default(30_000),

  /**
   * Reverse proxies in FRONT of gangway (Nginx Proxy Manager, a load balancer), as IPs or
   * CIDRs. X-Forwarded-For is believed only from these. Empty -- the default -- means
   * gangway faces the internet itself and believes no one. See net/trustedproxy.ts.
   */
  trustedProxies: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.string()).default([]),
  ),

  /**
   * How long a SIGTERM waits for in-flight requests and pipelines before closing them.
   * Keep it under the orchestrator's kill timeout (Docker's default is 10s).
   */
  shutdownGraceMs: z.coerce.number().int().min(0).default(8_000),

  tlsMode: z.enum(["acme", "selfsigned", "file"]).default("selfsigned"),
  tlsCertPath: z.string().optional(),
  tlsKeyPath: z.string().optional(),

  hosts: z.array(HostConfigSchema).default([HostConfigSchema.parse({})]),

  /** Phase 1 only: a static bearer token standing in for real auth (T14). */
  adminToken: z.string().optional(),

  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /**
   * Config overrides for database-backed settings. Present here means "managed by
   * config": the UI renders the control disabled rather than failing silently on click.
   */
  overrides: z.record(z.string(), z.unknown()).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/** env var -> config field. Only these are readable from the environment. */
const ENV_MAP = {
  GANGWAY_INSTANCE: "instanceId",
  GANGWAY_ENV: "environment",
  GANGWAY_STATE_DIR: "stateDir",
  GANGWAY_DATABASE_PATH: "databasePath",
  GANGWAY_LISTEN_ADDRESS: "listenAddress",
  GANGWAY_LISTEN_PORT: "listenPort",
  GANGWAY_LISTEN_HTTP_PORT: "listenHttpPort",
  GANGWAY_PUBLIC_SCHEME: "publicScheme",
  GANGWAY_PUBLIC_PORT: "publicPort",
  GANGWAY_MAX_BODY_BYTES: "maxBodyBytes",
  GANGWAY_UPSTREAM_TIMEOUT_MS: "upstreamTimeoutMs",
  GANGWAY_RECONCILE_INTERVAL_MS: "reconcileIntervalMs",
  GANGWAY_RECONCILE_ORPHANS: "reconcileOrphans",
  GANGWAY_TTL_SWEEP_INTERVAL_MS: "ttlSweepIntervalMs",
  GANGWAY_IDLE_SWEEP_INTERVAL_MS: "idleSweepIntervalMs",
  GANGWAY_WAKE_WAIT_MS: "wakeWaitMs",
  GANGWAY_LAST_SEEN_FLUSH_INTERVAL_MS: "lastSeenFlushIntervalMs",
  GANGWAY_SHUTDOWN_GRACE_MS: "shutdownGraceMs",
  GANGWAY_TRUSTED_PROXIES: "trustedProxies",
  GANGWAY_TLS_MODE: "tlsMode",
  GANGWAY_TLS_CERT_PATH: "tlsCertPath",
  GANGWAY_TLS_KEY_PATH: "tlsKeyPath",
  GANGWAY_ADMIN_TOKEN: "adminToken",
  GANGWAY_LOG_LEVEL: "logLevel",
} as const satisfies Record<string, keyof Config>;

/** Settings-table keys that may be pinned from the environment (§10.5 precedence). */
const SETTING_ENV_MAP = {
  GANGWAY_BASE_DOMAIN: "baseDomain",
  GANGWAY_SURFACE_UI: "surfaces.ui",
  GANGWAY_SURFACE_MCP: "surfaces.mcp",
  GANGWAY_DEFAULT_TTL: "defaults.ttl",
  GANGWAY_DEFAULT_VISIBILITY: "defaults.visibility",
  GANGWAY_DEFAULT_IDLE_AFTER: "defaults.idleAfter",
  GANGWAY_ACME_DIRECTORY_URL: "acme.directoryUrl",
  GANGWAY_ACME_EMAIL: "acme.email",
  GANGWAY_CF_API_TOKEN: "acme.cloudflare.apiToken",
  GANGWAY_CF_ZONE_ID: "acme.cloudflare.zoneId",
  GANGWAY_GITHUB_APP_ID: "github.appId",
  GANGWAY_GITHUB_APP_SLUG: "github.appSlug",
  GANGWAY_GITHUB_CLIENT_ID: "github.clientId",
  GANGWAY_GITHUB_CLIENT_SECRET: "github.clientSecret",
  GANGWAY_GITHUB_PRIVATE_KEY: "github.privateKey",
  GANGWAY_GITHUB_WEBHOOK_SECRET: "github.webhookSecret",
} as const;

function coerceEnv(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  fileConfig: Record<string, unknown> = {},
): Config {
  const fromEnv: Record<string, unknown> = {};
  for (const [envVar, field] of Object.entries(ENV_MAP)) {
    const v = env[envVar];
    if (v !== undefined && v !== "") fromEnv[field] = v;
  }
  if (env["GANGWAY_LISTEN_HTTP_PORT"] === "") fromEnv["listenHttpPort"] = null;

  const overrides: Record<string, unknown> = {
    ...((fileConfig["overrides"] as Record<string, unknown>) ?? {}),
  };
  for (const [envVar, key] of Object.entries(SETTING_ENV_MAP)) {
    const v = env[envVar];
    if (v !== undefined && v !== "") overrides[key] = coerceEnv(v);
  }

  return ConfigSchema.parse({ ...fileConfig, ...fromEnv, overrides });
}
