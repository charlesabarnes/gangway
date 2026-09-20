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
  GANGWAY_STATE_DIR: "stateDir",
  GANGWAY_DATABASE_PATH: "databasePath",
  GANGWAY_LISTEN_ADDRESS: "listenAddress",
  GANGWAY_LISTEN_PORT: "listenPort",
  GANGWAY_LISTEN_HTTP_PORT: "listenHttpPort",
  GANGWAY_PUBLIC_SCHEME: "publicScheme",
  GANGWAY_PUBLIC_PORT: "publicPort",
  GANGWAY_MAX_BODY_BYTES: "maxBodyBytes",
  GANGWAY_UPSTREAM_TIMEOUT_MS: "upstreamTimeoutMs",
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
  GANGWAY_ACME_DIRECTORY_URL: "acme.directoryUrl",
  GANGWAY_ACME_EMAIL: "acme.email",
  GANGWAY_CF_API_TOKEN: "acme.cloudflare.apiToken",
  GANGWAY_CF_ZONE_ID: "acme.cloudflare.zoneId",
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
