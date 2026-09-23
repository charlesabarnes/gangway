/** ADR-0018: the data browser -- drivers (pure) and the service (limits, refusals, audit) over a stubbed runner. */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import type { ComposeEvent, ComposeResult } from "../../src/docker/compose.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { parseBatch, parseCsv, queryArgv, redisRefusal, rowsQuery, tokenize } from "../../src/previews/data/drivers.ts";
import { DataBrowser, MAX_GLOBAL } from "../../src/previews/data/service.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import contract from "../../../web/src/testing/fixtures/contract.json";

describe("drivers", () => {
  test("psql CSV: NULL is an empty unquoted field, \"\" is an empty string, quotes and newlines survive", () => {
    expect(parseCsv('id,name,note\n1,"a, b",\n2,"",x\n3,"say ""hi""","two\nlines"\n')).toEqual({
      columns: ["id", "name", "note"],
      rows: [["1", "a, b", null], ["2", "", "x"], ["3", 'say "hi"', "two\nlines"]],
    });
    expect(parseCsv("")).toEqual({ columns: [], rows: [] });
  });

  test("mysql --batch: tabs, escapes, NULL", () => {
    expect(parseBatch("a\tb\n1\tNULL\nx\\ty\tline\\nbreak\n")).toEqual({ columns: ["a", "b"], rows: [["1", null], ["x\ty", "line\nbreak"]] });
  });

  test("no secret and no query text inside a shell script: the password comes from the container, the text is \"$1\"", () => {
    const my = queryArgv("mysql", "select '$(rm -rf /)'", false);
    expect(my[0]).toBe("sh");
    expect(my[2]).toContain(`MYSQL_PWD="$MYSQL_ROOT_PASSWORD"`);
    expect(my[2]).toContain(`-e "$1"`);
    expect(my[2]).toContain("READ ONLY");
    expect(my[2]).not.toContain("rm -rf");
    expect(my.at(-1)).toBe("select '$(rm -rf /)'");
    const pg = queryArgv("postgres", "select 1", false);
    expect(pg).toContain("SET default_transaction_read_only = on");
    expect(queryArgv("postgres", "select 1", true)).not.toContain("SET default_transaction_read_only = on");
    const rd = queryArgv("redis", `SET "a key" 'v 1'`, true);
    expect(rd.slice(-3)).toEqual(["SET", "a key", "v 1"]);
    expect(rd[2]).toContain(`REDISCLI_AUTH="$REDIS_PASSWORD"`);
  });

  test("table names are quoted by doubling", () => {
    expect(rowsQuery("postgres", { schema: "public", name: 'we"ird' }, 50, 0)).toBe(`select * from "public"."we""ird" limit 50 offset 0`);
    expect(rowsQuery("mysql", { schema: "app", name: "a`b" }, 10, 20)).toBe("select * from `app`.`a``b` limit 10 offset 20");
  });

  test("redis: tokenizing, the read allowlist, and what is never allowed", () => {
    expect(tokenize(`HSET "my key" field "va\\"lue"`)).toEqual(["HSET", "my key", "field", 'va"lue']);
    expect(() => tokenize(`GET "open`)).toThrow();
    expect(redisRefusal("GET x", false)).toBeNull();
    expect(redisRefusal("SET x 1", false)).toContain("turn on writes");
    expect(redisRefusal("SET x 1", true)).toBeNull();
    expect(redisRefusal("monitor", true)).toContain("not available");
    expect(redisRefusal("CONFIG SET dir /", true)).toContain("not available");
  });
});

async function tarball(files: Record<string, string>): Promise<Uint8Array> {
  const p = pack();
  for (const [name, content] of Object.entries(files)) p.entry({ name }, content);
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const c of p) chunks.push(c as Buffer);
  return gzipSync(Buffer.concat(chunks));
}

/** A deployed preview with postgres, and a runner that answers `docker ps` and `docker exec` as told. */
async function withPostgres(exec: (argv: string[], signal?: AbortSignal) => AsyncGenerator<ComposeEvent>) {
  const s = setupPreviewContext();
  s.ctx.sources = new SourceStore(dirname(s.ctx.workdirs.root));
  const res = await deploy(s.ctx, { actor: ACTOR, name: "data", visibility: "public", source: { kind: "tarball", archive: await tarball({ "index.ts": "" }), runtime: "bun", addons: ["postgres"] } });
  const p = await res.done;
  const real = s.ctx.compose;
  const seen: string[][] = [];
  s.ctx.compose = {
    stream: (argv, host, o) => (argv.includes("exec") ? (seen.push(argv), exec(argv, o.signal)) : real.stream(argv, host, o)),
    capture: async (argv, host, o): Promise<ComposeResult> => (argv[1] === "ps" && argv.includes("--quiet")
      ? { code: 0, stdout: "abcdef0123456789\n", stderr: "", signal: null }
      : real.capture(argv, host, o)),
  };
  return { s, p, data: new DataBrowser(s.ctx), seen };
}

const lines = (out: string[], code = 0) => async function* (): AsyncGenerator<ComposeEvent> {
  for (const line of out) yield { type: "line", stream: "stdout", line };
  yield { type: "exit", code, signal: null };
};

describe("the service", () => {
  test("a query runs in the add-on's container, parses, and is audited without its results", async () => {
    const { s, p, data, seen } = await withPostgres(lines(["n,secret_value", "1,hunter2"]));
    const r = await data.query(ACTOR, p.id, "postgres", "select n, secret_value from t", false);
    expect(r).toMatchObject({ columns: ["n", "secret_value"], rows: [["1", "hunter2"]], truncated: false });
    // The wire the UI reads (web/src/testing/fixtures/contract.json).
    expect(Object.keys(r).sort()).toEqual(Object.keys(contract.dataResult).sort());
    expect(Object.keys(data.list(p.id)[0]!).sort()).toEqual(Object.keys(contract.previewAddons[0]!).sort());
    expect(seen[0]!.slice(0, 3)).toEqual(["docker", "exec", "abcdef0123456789"]);
    const entry = s.audit.page({ limit: 5 }).entries.find((e) => e.action === "preview.data.query")!;
    expect(JSON.stringify(entry)).toContain("select n, secret_value from t");
    expect(JSON.stringify(entry)).not.toContain("hunter2");
  });

  test("rows only for a table the database listed", async () => {
    const { p, data } = await withPostgres(async function* (argv) {
      const text = argv.at(-1)!;
      for (const line of text.startsWith("select table_schema") ? ["schema,name", "public,visits"] : ["n", "7"]) yield { type: "line", stream: "stdout", line };
      yield { type: "exit", code: 0, signal: null };
    });
    expect((await data.rows(ACTOR, p.id, "postgres", { schema: "public", name: "visits" }, 50, 0)).rows).toEqual([["7"]]);
    await expect(data.rows(ACTOR, p.id, "postgres", { schema: "public", name: "users; drop table visits" }, 50, 0)).rejects.toMatchObject({ code: "not_found" });
  });

  test("an error from the database is a 422 with its message; a missing add-on is 404; a sleeping preview is 409", async () => {
    const { s, p, data } = await withPostgres(async function* () {
      yield { type: "line", stream: "stderr", line: "ERROR:  relation \"nope\" does not exist" };
      yield { type: "exit", code: 1, signal: null };
    });
    await expect(data.query(ACTOR, p.id, "postgres", "select * from nope", false)).rejects.toMatchObject({ code: "unprocessable", message: expect.stringContaining("does not exist") });
    await expect(data.query(ACTOR, p.id, "redis", "GET x", false)).rejects.toMatchObject({ code: "not_found" });
    s.ctx.states.transition(p.id, "asleep");
    await expect(data.query(ACTOR, p.id, "postgres", "select 1", false)).rejects.toMatchObject({ code: "conflict" });
  });

  test("output past the cap is cut and says so; past the row cap too", async () => {
    const big = "x".repeat(64 * 1024);
    const { p, data } = await withPostgres(async function* (_argv, signal) {
      yield { type: "line", stream: "stdout", line: "c" };
      for (let i = 0; i < 100 && !signal?.aborted; i++) yield { type: "line", stream: "stdout", line: big };
      yield { type: "exit", code: signal?.aborted ? 137 : 0, signal: null };
    });
    const r = await data.query(ACTOR, p.id, "postgres", "select big", false);
    expect(r.truncated).toBe(true);
    const many = await withPostgres(lines(["n", ...Array.from({ length: 1500 }, (_, i) => String(i))]));
    const m = await many.data.query(ACTOR, many.p.id, "postgres", "select n", false);
    expect(m.rows).toHaveLength(1000);
    expect(m.truncated).toBe(true);
  });

  test("one query per preview at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { p, data } = await withPostgres(async function* () { await gate; yield { type: "exit", code: 0, signal: null }; });
    const first = data.query(ACTOR, p.id, "postgres", "select pg_sleep(1)", false);
    await Bun.sleep(5);
    await expect(data.query(ACTOR, p.id, "postgres", "select 1", false)).rejects.toMatchObject({ code: "conflict" });
    release();
    await first;
    expect(MAX_GLOBAL).toBe(4);
  });

  test("redis writes are refused read-only before anything runs", async () => {
    const { data, seen, p } = await withPostgres(lines([]));
    await expect(data.query(ACTOR, p.id, "postgres", "", false)).rejects.toMatchObject({ code: "unprocessable" });
    expect(seen).toHaveLength(0);
    // Refused by the read allowlist before anything is looked up or run.
    await expect(data.query(ACTOR, p.id, "redis", "FLUSHALL", false)).rejects.toMatchObject({ code: "unprocessable" });
  });

  test("list: names and variable NAMES, no values", async () => {
    const { data, p } = await withPostgres(lines([]));
    expect(data.list(p.id)).toEqual([{ id: "postgres", version: "18", name: "PostgreSQL", service: "postgres", env: expect.arrayContaining(["DATABASE_URL"]) }]);
  });
});
