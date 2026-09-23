/**
 * Structured JSON-lines logging with secret redaction.
 *
 * Redaction is not decoration: build logs, git clone output and compose stderr all flow
 * through here and out to SSE clients, PR comments and disk. A leaked `gw_` token or a
 * GitHub installation token in a log line is a real credential disclosure.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Token shapes worth catching on sight, independent of the field they arrive in. */
const SECRET_PATTERNS: RegExp[] = [
  /gw_[A-Za-z0-9_-]{16,}/g,                 // our own API tokens
  /gh[pousr]_[A-Za-z0-9]{20,}/g,            // GitHub PAT / OAuth / installation tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b[A-Za-z0-9._-]+:[^@\s/]{6,}@/g,        // credentials embedded in a URL
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

/** Field names whose value is always replaced, whatever it looks like. */
const SECRET_KEYS = new Set([
  "password", "passwordhash", "token", "apitoken", "api_token", "accesstoken",
  "secret", "clientsecret", "client_secret", "privatekey", "private_key",
  "authorization", "cookie", "set-cookie", "webhooksecret", "webhook_secret",
  "accountkey", "account_key", "key",
]);

export function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  // A Date has no own enumerable properties: walked as an object it becomes `{}`. The first
  // production audit row (token.created, expiresAt) stored exactly that.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    // An AppError's `code` and `detail` are the part worth reading -- `compose config`'s
    // stderr lives there; without them the log says only "the compose file is not valid".
    const extra = value as Error & { code?: unknown; detail?: unknown };
    return {
      name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined,
      ...(extra.code !== undefined ? { code: extra.code } : {}),
      ...(extra.detail !== undefined ? { detail: redact(extra.detail, depth + 1) } : {}),
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export type LogFields = Record<string, unknown>;
export type Sink = (line: string) => void;

export class Logger {
  #level: LogLevel;
  #base: LogFields;
  #sink: Sink;

  constructor(level: LogLevel = "info", base: LogFields = {}, sink: Sink = (l) => console.log(l)) {
    this.#level = level;
    this.#base = base;
    this.#sink = sink;
  }

  child(fields: LogFields): Logger {
    return new Logger(this.#level, { ...this.#base, ...fields }, this.#sink);
  }

  #log(level: LogLevel, msg: string, fields?: LogFields) {
    if (ORDER[level] < ORDER[this.#level]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: redactString(msg),
      ...(redact({ ...this.#base, ...fields }) as LogFields),
    };
    this.#sink(JSON.stringify(record));
  }

  debug(msg: string, f?: LogFields) { this.#log("debug", msg, f); }
  info(msg: string, f?: LogFields) { this.#log("info", msg, f); }
  warn(msg: string, f?: LogFields) { this.#log("warn", msg, f); }
  error(msg: string, f?: LogFields) { this.#log("error", msg, f); }
}
