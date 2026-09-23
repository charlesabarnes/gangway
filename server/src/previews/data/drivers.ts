/**
 * The data browser's drivers: for each add-on, the argv that runs a query inside
 * its container, and a parser for what comes back. Pure -- no process, no daemon.
 *
 * Nothing secret is ever on a command line: every command runs as `sh -c '<fixed script>'`
 * and reads the password from the container's own environment (the add-on's service was
 * given it at deploy). The query text arrives as a positional argument (`"$1"`), never
 * spliced into the script, so no shell or SQL quoting of ours is involved in carrying it.
 * Table names come from the add-on's own listing and are quoted by doubling.
 */
import type { AddonId } from "@gangway/shared/addons";
import { ADDON_USER } from "../addons.ts";

export type Cell = string | null;
export type QueryResult = {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
  message: string | null;
};
export type Table = { schema: string; name: string };

/** Hard limits, shared with the service. */
export const MAX_ROWS = 1000;
const STATEMENT_TIMEOUT_S = 15;

/* ------------------------------------------------------------------ argv */

/** `sh -c <script> sh <args...>`: the script is ours and fixed; what follows it is data. */
const sh = (script: string, ...args: string[]) => ["sh", "-c", script, "sh", ...args];

export function queryArgv(addon: AddonId, text: string, write: boolean): string[] {
  switch (addon) {
    case "postgres":
      // Local socket: the official image trusts it, so no password is needed at all.
      return [
        "psql",
        "-X",
        "-q",
        "-U",
        ADDON_USER,
        "-d",
        ADDON_USER,
        "--csv",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `SET statement_timeout = '${STATEMENT_TIMEOUT_S}s'`,
        ...(write ? [] : ["-c", "SET default_transaction_read_only = on"]),
        "-c",
        text,
      ];
    case "mysql":
      return sh(
        `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --database=${ADDON_USER} --batch --init-command="SET SESSION max_execution_time=${STATEMENT_TIMEOUT_S * 1000};${write ? "" : " SET SESSION TRANSACTION READ ONLY;"}" -e "$1"`,
        text,
      );
    case "redis": {
      const argv = redisArgv(text);
      return sh(`REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning "$@"`, ...argv);
    }
  }
}

export function tablesQuery(addon: Exclude<AddonId, "redis">): string {
  return addon === "postgres"
    ? "select table_schema as schema, table_name as name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2"
    : `select table_schema as \`schema\`, table_name as name from information_schema.tables where table_schema = '${ADDON_USER}' order by 2`;
}

/** Only ever called with a name the add-on listed itself; quoted by doubling anyway. */
export function rowsQuery(
  addon: Exclude<AddonId, "redis">,
  t: Table,
  limit: number,
  offset: number,
): string {
  const q =
    addon === "postgres"
      ? (s: string) => `"${s.replace(/"/g, '""')}"`
      : (s: string) => `\`${s.replace(/`/g, "``")}\``;
  return `select * from ${q(t.schema)}.${q(t.name)} limit ${Math.trunc(limit)} offset ${Math.trunc(offset)}`;
}

/* ------------------------------------------------------------------ redis */

/**
 * Words, with double or single quotes grouping and backslash escapes inside double quotes:
 * redis-cli's own rules, roughly.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "",
    inWord = false,
    quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (c === "\\" && quote === '"' && i + 1 < text.length) {
        cur += text[++i]!;
        continue;
      }
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) {
        out.push(cur);
        cur = "";
        inWord = false;
      }
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) throw new Error("an unclosed quote");
  if (inWord) out.push(cur);
  return out;
}

/** What read-only mode lets through. Anything else needs the write switch. */
const REDIS_READ = new Set([
  "GET",
  "MGET",
  "STRLEN",
  "GETRANGE",
  "EXISTS",
  "TYPE",
  "TTL",
  "PTTL",
  "KEYS",
  "SCAN",
  "DBSIZE",
  "INFO",
  "PING",
  "RANDOMKEY",
  "HGET",
  "HMGET",
  "HGETALL",
  "HKEYS",
  "HVALS",
  "HLEN",
  "HEXISTS",
  "HSCAN",
  "LRANGE",
  "LLEN",
  "LINDEX",
  "SMEMBERS",
  "SCARD",
  "SISMEMBER",
  "SSCAN",
  "SRANDMEMBER",
  "ZRANGE",
  "ZRANGEBYSCORE",
  "ZREVRANGE",
  "ZCARD",
  "ZSCORE",
  "ZRANK",
  "ZSCAN",
  "ZCOUNT",
  "XRANGE",
  "XREVRANGE",
  "XLEN",
  "XINFO",
  "OBJECT",
  "MEMORY",
  "TIME",
  "DUMP",
]);
/** Never, write switch or not: they block, stream forever, or reach past this one database. */
const REDIS_NEVER = new Set([
  "MONITOR",
  "SUBSCRIBE",
  "PSUBSCRIBE",
  "SSUBSCRIBE",
  "SYNC",
  "PSYNC",
  "SHUTDOWN",
  "CONFIG",
  "DEBUG",
  "MODULE",
  "ACL",
  "REPLICAOF",
  "SLAVEOF",
  "CLIENT",
  "FAILOVER",
  "CLUSTER",
  "SAVE",
  "BGSAVE",
  "BGREWRITEAOF",
  "MIGRATE",
  "BLPOP",
  "BRPOP",
  "BLMOVE",
  "BZPOPMIN",
  "BZPOPMAX",
  "XREAD",
  "XREADGROUP",
  "WAIT",
  "SCRIPT",
  "FUNCTION",
]);

function redisArgv(text: string): string[] {
  const argv = tokenize(text);
  if (argv.length === 0) throw new Error("no command");
  if (argv.length > 256) throw new Error("too many arguments");
  return argv;
}

/** null: allowed. Otherwise why not. */
export function redisRefusal(text: string, write: boolean): string | null {
  let argv: string[];
  try {
    argv = redisArgv(text);
  } catch (e) {
    return e instanceof Error ? e.message : "cannot parse the command";
  }
  const cmd = argv[0]!.toUpperCase();
  if (REDIS_NEVER.has(cmd)) return `${cmd} is not available here`;
  if (!write && !REDIS_READ.has(cmd)) return `${cmd} can change data: turn on writes to run it`;
  return null;
}

/* ------------------------------------------------------------------ parsing */

/**
 * psql's CSV: RFC 4180. A NULL is an empty unquoted field; an empty string is `""`. The
 * first record is the header. No output at all is a statement that returns no rows.
 */
export function parseCsv(text: string): { columns: string[]; rows: Cell[][] } {
  const records: Cell[][] = [];
  let rec: Cell[] = [],
    field = "",
    quoted = false,
    inQuotes = false,
    any = false;
  const endField = () => {
    rec.push(!quoted && field === "" ? null : field);
    field = "";
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    any = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
      quoted = true;
    } else if (c === ",") endField();
    else if (c === "\n") {
      endField();
      records.push(rec);
      rec = [];
      any = false;
    } else if (c !== "\r") field += c;
  }
  if (any || field !== "" || rec.length > 0) {
    endField();
    records.push(rec);
  }
  const [header, ...rows] = records;
  return { columns: (header ?? []).map((h) => h ?? ""), rows };
}

/**
 * mysql --batch: tab-separated, a header first; `\t \n \\ \0` escaped; NULL is the text NULL,
 * which is ambiguous with the string "NULL".
 */
export function parseBatch(text: string): { columns: string[]; rows: Cell[][] } {
  const unescape = (s: string): Cell =>
    s === "NULL"
      ? null
      : s.replace(/\\(.)/g, (_, c: string) =>
          c === "t" ? "\t" : c === "n" ? "\n" : c === "0" ? "\0" : c,
        );
  const lines = text.split("\n").filter((l, i, a) => !(l === "" && i === a.length - 1));
  if (lines.length === 0) return { columns: [], rows: [] };
  const [header, ...rest] = lines;
  return { columns: header!.split("\t"), rows: rest.map((l) => l.split("\t").map(unescape)) };
}

/** redis-cli's non-tty output: one line per value. Shown as a one-column table. */
function parseRedis(text: string): { columns: string[]; rows: Cell[][] } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { columns: ["value"], rows: lines.map((l) => [l]) };
}

export function parse(addon: AddonId, text: string): { columns: string[]; rows: Cell[][] } {
  return addon === "postgres"
    ? parseCsv(text)
    : addon === "mysql"
      ? parseBatch(text)
      : parseRedis(text);
}
