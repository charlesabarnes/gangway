import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addonById, type AddonChoice, type AddonId } from "@gangway/shared/addons";
import type { Host, Preview } from "@gangway/shared/domain";
import type { Actor } from "../../auth/actor.ts";
import { AppError, conflict, notFound, unprocessable } from "../../errors.ts";
import type { PreviewContext } from "../context.ts";
import { redisRefusal, rowsQuery, tablesQuery, type Table } from "./drivers.ts";
import {
  execQuery,
  findContainer,
  toResult,
  WALL_CLOCK_MS,
  type Exec,
  type TimedResult,
} from "./exec.ts";

export const MAX_GLOBAL = 4;
const MAX_QUERY_CHARS = 64 * 1024;

export type AddonView = AddonChoice & { name: string; service: string; env: readonly string[] };

/** One statement to run against an add-on, and what it is for in the audit log. */
type Statement = { addon: AddonId; text: string; write: boolean; kind: string };

type DataContext = Pick<PreviewContext, "previews" | "hosts" | "audit" | "compose" | "docker">;

export class DataBrowser {
  readonly #ctx: DataContext;
  readonly #busy = new Set<string>();

  constructor(ctx: DataContext) {
    this.#ctx = ctx;
  }

  list(previewId: string): AddonView[] {
    const p = this.#preview(previewId);
    const addons = p.source.kind === "tarball" ? (p.source.addons ?? []) : [];
    return addons.map((a) => {
      const d = addonById(a.id);
      return { ...a, name: d.name, service: d.service, env: d.env };
    });
  }

  async tables(actor: Actor, previewId: string, addon: AddonId): Promise<Table[]> {
    if (addon === "redis") {
      throw unprocessable("Redis has keys, not tables: use /keys");
    }
    const r = await this.#run(actor, previewId, {
      addon,
      text: tablesQuery(addon),
      write: false,
      kind: "tables",
    });
    return r.rows.map((row) => ({ schema: row[0] ?? "", name: row[1] ?? "" }));
  }

  async rows(
    actor: Actor,
    previewId: string,
    addon: AddonId,
    { table, limit, offset }: { table: Table; limit: number; offset: number },
  ): Promise<TimedResult> {
    if (addon === "redis") {
      throw unprocessable("Redis has keys, not tables: use /keys");
    }
    const known = await this.tables(actor, previewId, addon);
    if (!known.some((t) => t.schema === table.schema && t.name === table.name)) {
      throw notFound(`no table ${table.schema}.${table.name}`);
    }
    return this.#run(actor, previewId, {
      addon,
      text: rowsQuery(addon, table, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)),
      write: false,
      kind: "rows",
    });
  }

  async keys(
    actor: Actor,
    previewId: string,
    cursor: string,
    match: string,
  ): Promise<{ cursor: string; keys: string[] }> {
    if (!/^\d{1,20}$/.test(cursor)) {
      throw unprocessable("cursor is a number");
    }
    const r = await this.#run(actor, previewId, {
      addon: "redis",
      text: `SCAN ${cursor} MATCH ${JSON.stringify(match || "*")} COUNT 200`,
      write: false,
      kind: "keys",
    });
    const [next, ...keys] = r.rows.map((row) => row[0] ?? "");
    return { cursor: next ?? "0", keys };
  }

  async key(
    actor: Actor,
    previewId: string,
    name: string,
  ): Promise<{ type: string; ttl: string; value: TimedResult }> {
    const k = JSON.stringify(name);
    const type =
      (
        await this.#run(actor, previewId, {
          addon: "redis",
          text: `TYPE ${k}`,
          write: false,
          kind: "key",
        })
      ).rows[0]?.[0] ?? "none";
    const ttl =
      (
        await this.#run(actor, previewId, {
          addon: "redis",
          text: `TTL ${k}`,
          write: false,
          kind: "key",
        })
      ).rows[0]?.[0] ?? "-2";
    const read: Record<string, string> = {
      string: `GET ${k}`,
      hash: `HGETALL ${k}`,
      list: `LRANGE ${k} 0 199`,
      set: `SSCAN ${k} 0 COUNT 200`,
      zset: `ZRANGE ${k} 0 199 WITHSCORES`,
      stream: `XRANGE ${k} - + COUNT 50`,
    };
    const value = read[type]
      ? await this.#run(actor, previewId, {
          addon: "redis",
          text: read[type],
          write: false,
          kind: "key",
        })
      : { columns: ["value"], rows: [], truncated: false, message: null, ms: 0 };
    return { type, ttl, value };
  }

  async query(
    actor: Actor,
    previewId: string,
    addon: AddonId,
    { text, write }: { text: string; write: boolean },
  ): Promise<TimedResult> {
    if (text.trim() === "") {
      throw unprocessable("nothing to run");
    }
    if (text.length > MAX_QUERY_CHARS) {
      throw unprocessable(`a query is at most ${MAX_QUERY_CHARS} characters`);
    }
    if (addon === "redis") {
      const why = redisRefusal(text, write);
      if (why) {
        throw unprocessable(why);
      }
    }
    return this.#run(actor, previewId, { addon, text, write, kind: "query" });
  }

  #preview(previewId: string): Preview {
    const p = this.#ctx.previews.get(previewId);
    if (!p || p.state === "destroyed") {
      throw notFound(`no such preview: ${previewId}`);
    }
    return p;
  }

  #target(previewId: string, addon: AddonId): { preview: Preview; host: Host } {
    const p = this.#preview(previewId);
    if (!this.list(previewId).some((a) => a.id === addon)) {
      throw notFound(`this preview has no ${addon} add-on`);
    }
    if (p.state !== "awake") {
      throw conflict(`the preview is ${p.state}; open it to wake it first`, { state: p.state });
    }
    const host = this.#ctx.hosts.get(p.hostId);
    if (!host) {
      throw new AppError("internal", `preview ${previewId} is on unknown host ${p.hostId}`);
    }
    return { preview: p, host };
  }

  #claim(previewId: string): void {
    if (this.#busy.has(previewId)) {
      throw conflict("a query on this preview is still running");
    }
    if (this.#busy.size >= MAX_GLOBAL) {
      throw new AppError(
        "unavailable",
        "too many queries are running; try again in a moment",
        undefined,
        { "retry-after": "2" },
      );
    }
    this.#busy.add(previewId);
  }

  async #run(
    actor: Actor,
    previewId: string,
    { addon, text, write, kind }: Statement,
  ): Promise<TimedResult> {
    const ctx = this.#ctx;
    const { preview, host } = this.#target(previewId, addon);
    this.#claim(previewId);
    const started = Date.now();
    const cwd = await mkdtemp(join(tmpdir(), "gangway-data-"));
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
    }, WALL_CLOCK_MS);
    const x: Exec = { ctx, preview, host, addon, cwd, abort, outcome: "ok" };
    let result: TimedResult | null = null;
    try {
      const container = await findContainer(x);
      const output = await execQuery(x, container, text, write);
      result = toResult(x, output, Date.now() - started);
      return result;
    } catch (e) {
      if (x.outcome === "ok") {
        x.outcome = "error";
      }
      throw e;
    } finally {
      clearTimeout(timer);
      this.#busy.delete(previewId);
      await rm(cwd, { recursive: true, force: true });
      // Not named key: redact() hides a field of that name.
      if (kind === "query" || kind === "rows") {
        ctx.audit.record(actor, "preview.data.query", previewId, {
          new: {
            addon,
            kind,
            text: auditText(addon, text).slice(0, 2_048),
            write,
            outcome: x.outcome,
            rows: result?.rows.length ?? 0,
            ms: Date.now() - started,
          },
        });
      }
    }
  }
}

/**
 * What the audit log keeps of a statement: its shape, not its values. A query can carry
 * passwords or personal data in its literals, so SQL strings and numbers become ?, and a Redis
 * command keeps only its name and key.
 */
export function auditText(addon: AddonId, text: string): string {
  if (addon === "redis") {
    const [cmd = "", key, ...rest] = text.trim().split(/\s+/);
    return [cmd, key, ...rest.map(() => "?")].filter((w) => w !== undefined).join(" ");
  }
  return text
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "?")
    .replace(/[EeXxBbNn]?'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "?");
}
