/**
 * The data browser: look inside a preview's add-on databases without a port
 * ever being published. Every command is `docker exec` into the add-on's container, through
 * the same runner (and the same daemon guard) as every compose command, bounded in time,
 * output and concurrency, and audited -- the query text, never the results.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addonById, type AddonChoice, type AddonId } from "@gangway/shared/addons";
import type { Preview } from "@gangway/shared/domain";
import type { Actor } from "../../auth/actor.ts";
import { AppError, conflict, notFound, unprocessable } from "../../errors.ts";
import type { PreviewContext } from "../context.ts";
import {
  MAX_ROWS,
  parse,
  queryArgv,
  redisRefusal,
  rowsQuery,
  tablesQuery,
  type QueryResult,
  type Table,
} from "./drivers.ts";

const WALL_CLOCK_MS = 20_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_GLOBAL = 4;
const MAX_QUERY_CHARS = 64 * 1024;

export type AddonView = AddonChoice & { name: string; service: string; env: readonly string[] };
export type TimedResult = QueryResult & { ms: number };

export class DataBrowser {
  readonly #ctx: PreviewContext;
  readonly #busy = new Set<string>();

  constructor(ctx: PreviewContext) {
    this.#ctx = ctx;
  }

  /** The add-ons a preview has, for `previews.read`: names and variable names, no values. */
  list(previewId: string): AddonView[] {
    const p = this.#preview(previewId);
    const addons = p.source.kind === "tarball" ? (p.source.addons ?? []) : [];
    return addons.map((a) => {
      const d = addonById(a.id);
      return { ...a, name: d.name, service: d.service, env: d.env };
    });
  }

  async tables(actor: Actor, previewId: string, addon: AddonId): Promise<Table[]> {
    if (addon === "redis") throw unprocessable("Redis has keys, not tables: use /keys");
    const r = await this.#run(actor, previewId, addon, tablesQuery(addon), false, "tables");
    return r.rows.map((row) => ({ schema: row[0] ?? "", name: row[1] ?? "" }));
  }

  async rows(
    actor: Actor,
    previewId: string,
    addon: AddonId,
    table: Table,
    limit: number,
    offset: number,
  ): Promise<TimedResult> {
    if (addon === "redis") throw unprocessable("Redis has keys, not tables: use /keys");
    // Only a name the database itself listed: the quoting in rowsQuery is the second line of
    // defence, not the first.
    const known = await this.tables(actor, previewId, addon);
    if (!known.some((t) => t.schema === table.schema && t.name === table.name))
      throw notFound(`no table ${table.schema}.${table.name}`);
    return this.#run(
      actor,
      previewId,
      addon,
      rowsQuery(addon, table, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)),
      false,
      "rows",
    );
  }

  /**
   * A page of keys: `SCAN <cursor> MATCH <pattern> COUNT 200`. The first row is the next cursor
   * ("0": done).
   */
  async keys(
    actor: Actor,
    previewId: string,
    cursor: string,
    match: string,
  ): Promise<{ cursor: string; keys: string[] }> {
    if (!/^\d{1,20}$/.test(cursor)) throw unprocessable("cursor is a number");
    const r = await this.#run(
      actor,
      previewId,
      "redis",
      `SCAN ${cursor} MATCH ${JSON.stringify(match || "*")} COUNT 200`,
      false,
      "keys",
    );
    const [next, ...keys] = r.rows.map((row) => row[0] ?? "");
    return { cursor: next ?? "0", keys };
  }

  /** One key: its type, TTL and (the first 200 of) its value. */
  async key(
    actor: Actor,
    previewId: string,
    name: string,
  ): Promise<{ type: string; ttl: string; value: TimedResult }> {
    const k = JSON.stringify(name);
    const type =
      (await this.#run(actor, previewId, "redis", `TYPE ${k}`, false, "key")).rows[0]?.[0] ??
      "none";
    const ttl =
      (await this.#run(actor, previewId, "redis", `TTL ${k}`, false, "key")).rows[0]?.[0] ?? "-2";
    const read: Record<string, string> = {
      string: `GET ${k}`,
      hash: `HGETALL ${k}`,
      list: `LRANGE ${k} 0 199`,
      set: `SSCAN ${k} 0 COUNT 200`,
      zset: `ZRANGE ${k} 0 199 WITHSCORES`,
      stream: `XRANGE ${k} - + COUNT 50`,
    };
    const value = read[type]
      ? await this.#run(actor, previewId, "redis", read[type], false, "key")
      : { columns: ["value"], rows: [], truncated: false, message: null, ms: 0 };
    return { type, ttl, value };
  }

  /**
   * The console. `write: false` (the default) runs read-only: a read-only transaction, or the
   * read allowlist for Redis.
   */
  async query(
    actor: Actor,
    previewId: string,
    addon: AddonId,
    text: string,
    write: boolean,
  ): Promise<TimedResult> {
    if (text.trim() === "") throw unprocessable("nothing to run");
    if (text.length > MAX_QUERY_CHARS)
      throw unprocessable(`a query is at most ${MAX_QUERY_CHARS} characters`);
    if (addon === "redis") {
      const why = redisRefusal(text, write);
      if (why) throw unprocessable(why);
    }
    return this.#run(actor, previewId, addon, text, write, "query");
  }

  #preview(previewId: string): Preview {
    const p = this.#ctx.previews.get(previewId);
    if (!p || p.state === "destroyed") throw notFound(`no such preview: ${previewId}`);
    return p;
  }

  async #run(
    actor: Actor,
    previewId: string,
    addon: AddonId,
    text: string,
    write: boolean,
    kind: string,
  ): Promise<TimedResult> {
    const ctx = this.#ctx;
    const p = this.#preview(previewId);
    if (!this.list(previewId).some((a) => a.id === addon))
      throw notFound(`this preview has no ${addon} add-on`);
    if (p.state !== "awake")
      throw conflict(`the preview is ${p.state}; open it to wake it first`, { state: p.state });
    const host = ctx.hosts.get(p.hostId);
    if (!host)
      throw new AppError("internal", `preview ${previewId} is on unknown host ${p.hostId}`);
    if (this.#busy.has(previewId)) throw conflict("a query on this preview is still running");
    if (this.#busy.size >= MAX_GLOBAL)
      throw new AppError(
        "unavailable",
        "too many queries are running; try again in a moment",
        undefined,
        { "retry-after": "2" },
      );

    this.#busy.add(previewId);
    const started = Date.now();
    const empty = await mkdtemp(join(tmpdir(), "gangway-data-"));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), WALL_CLOCK_MS);
    let outcome = "ok";
    let result: TimedResult | null = null;
    try {
      const docker = ctx.docker ?? "docker";
      const service = addonById(addon).service;
      const ps = await ctx.compose.capture(
        [
          docker,
          "ps",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${p.project}`,
          "--filter",
          `label=com.docker.compose.service=${service}`,
        ],
        host,
        { cwd: empty },
      );
      const container = ps.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /^[0-9a-f]{12,64}$/.test(l));
      if (ps.code !== 0 || !container) {
        outcome = "not running";
        throw conflict(`the ${addonById(addon).name} container is not running`);
      }

      const out: string[] = [];
      const err: string[] = [];
      let bytes = 0,
        truncated = false,
        code = -1;
      for await (const ev of ctx.compose.stream(
        [docker, "exec", container, ...queryArgv(addon, text, write)],
        host,
        { cwd: empty, signal: abort.signal },
      )) {
        if (ev.type === "exit") {
          code = ev.code;
          break;
        }
        bytes += ev.line.length + 1;
        if (bytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          abort.abort();
          break;
        }
        (ev.stream === "stdout" ? out : err).push(ev.line);
      }
      const ms = Date.now() - started;
      if (!truncated && abort.signal.aborted) {
        outcome = "timeout";
        throw new AppError(
          "unavailable",
          `the query ran longer than ${WALL_CLOCK_MS / 1000}s and was stopped`,
        );
      }
      if (!truncated && code !== 0) {
        outcome = "error";
        throw unprocessable(
          err.join("\n").trim().slice(-2_000) || `${addonById(addon).name} exited ${code}`,
        );
      }
      const parsed = parse(addon, out.join("\n"));
      const rows = parsed.rows.slice(0, MAX_ROWS);
      result = {
        columns: parsed.columns,
        rows,
        ms,
        truncated: truncated || parsed.rows.length > MAX_ROWS,
        message: err.join("\n").trim().slice(-500) || null,
      };
      return result;
    } catch (e) {
      if (outcome === "ok") outcome = "error";
      throw e;
    } finally {
      clearTimeout(timer);
      this.#busy.delete(previewId);
      await rm(empty, { recursive: true, force: true });
      // What was asked, and how it went -- never what came back. Not `key`: redact() hides a
      // field of that name.
      if (kind === "query" || kind === "rows") {
        ctx.audit.record(actor, "preview.data.query", previewId, {
          new: {
            addon,
            kind,
            text: text.slice(0, 2_048),
            write,
            outcome,
            rows: result?.rows.length ?? 0,
            ms: Date.now() - started,
          },
        });
      }
    }
  }
}
