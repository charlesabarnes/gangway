/**
 * §10.2 the MCP tools and the `mcp` surface (ADR-0019). The tools run over a real
 * PreviewContext with only compose faked; the surface is driven with real JSON-RPC in both
 * protocol eras.
 */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { McpSurface } from "../../src/app/mcp-surface.ts";
import { staticTokenVerifier, tokenActor, type Actor } from "../../src/auth/actor.ts";
import { IdempotencyRepo } from "../../src/db/repos/index.ts";
import { Logger } from "../../src/logger.ts";
import { checkFiles, packFiles } from "../../src/mcp/pack.ts";
import { resolvePreview } from "../../src/mcp/resolve.ts";
import { TOOL_PERMISSIONS, Tools, type CallScope } from "../../src/mcp/tools.ts";
import { IdempotentDeploys } from "../../src/previews/idempotent.ts";
import { extractTarball } from "../../src/previews/source/tarball.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quiet = new Logger("error", {}, () => {});
const READ_ONLY = tokenActor("t-read", ["read"]) as Actor;

function setup() {
  const s = setupPreviewContext();
  s.ctx.sources = new SourceStore(dirname(s.ctx.workdirs.root));
  const deploys = new IdempotentDeploys(s.ctx, new IdempotencyRepo(s.db, s.ctx.now));
  const tools = new Tools({ ctx: s.ctx, deploys, logger: quiet });
  const scope = (actor: Actor = ACTOR, signal = new AbortController().signal): CallScope => ({ actor, signal });
  return { ...s, deploys, tools, scope };
}

describe("files -> a tarball", () => {
  test("deterministic, and the digest follows the contents, not the order they were given in", async () => {
    const a = await packFiles({ "index.html": "<h1>hi</h1>", "css/site.css": "body{}" });
    const b = await packFiles({ "css/site.css": "body{}", "index.html": "<h1>hi</h1>" });
    expect(a.digest).toBe(b.digest);
    expect(Buffer.from(a.archive).equals(Buffer.from(b.archive))).toBe(true);
    expect((await packFiles({ "index.html": "<h1>ho</h1>", "css/site.css": "body{}" })).digest).not.toBe(a.digest);
    const dir = mkdtempSync(join(tmpdir(), "gangway-pack-"));
    await extractTarball(a.archive, dir);
    expect(readFileSync(join(dir, "css/site.css"), "utf8")).toBe("body{}");
  });

  test.each([
    [{}, "empty"],
    [{ "../x": "" }, "`..`"],
    [{ "/etc/passwd": "" }, "relative"],
    [{ ".gangway/run.sh": "" }, ".gangway/"],
    [{ "a\\b": "" }, "backslash"],
    [{ big: "x".repeat(2 * 1024 * 1024 + 1) }, "MiB"],
  ])("refuses %j", (files, why) => {
    expect(() => checkFiles(files as Record<string, string>)).toThrow(why);
  });

  test("at most 1000 files", () => {
    expect(() => checkFiles(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}`, ""])))).toThrow("1000");
  });
});

describe("the tools", () => {
  test("each tool names its permission; there are exactly four", () => {
    expect(TOOL_PERMISSIONS).toEqual({ deploy: "previews.deploy", status: "previews.read", logs: "logs.read", destroy: "previews.destroy" });
  });

  test("deploy from files: blocks until it answers and returns the URL; status, logs and destroy find it by name", async () => {
    const s = setup();
    const out = await s.tools.deploy(s.scope(), { files: { "index.html": "<h1>hi</h1>" }, name: "hello", visibility: "public" });
    expect(out).toStartWith("ready: https://hello.preview.localhost:8443/");
    expect(out).toContain("hello: awake");
    const p = resolvePreview(s.ctx, "hello");
    expect(p.source).toMatchObject({ kind: "tarball", runtime: "static" });

    expect(await s.tools.status(s.scope(), "hello")).toStartWith("hello: awake — https://hello.preview.localhost:8443/");
    expect(await s.tools.status(s.scope(), "https://hello.preview.localhost:8443/some/page")).toStartWith("hello: awake");
    expect(await s.tools.status(s.scope(), p.id)).toStartWith("hello: awake");
    expect(await s.tools.status(s.scope(), undefined)).toStartWith("1 preview:\nhello: awake");
    expect(await s.tools.logs(s.scope(), "hello", 5)).toContain("hello: awake");

    expect(await s.tools.destroy(s.scope(), "hello")).toBe("destroyed hello");
    expect(await s.tools.status(s.scope(), undefined)).toBe("no previews");
  });

  test("a retry of the same call is the same preview (no key given); other contents under the same name are not a retry", async () => {
    const s = setup();
    const args = { files: { "index.html": "a" }, name: "retry", visibility: "public" as const };
    const first = await s.tools.deploy(s.scope(), args);
    const again = await s.tools.deploy(s.scope(), args);
    expect(again).toContain("the same preview an earlier identical call made");
    expect(s.ctx.previews.list({}).length).toBe(1);
    // Other contents under the same name: not a retry, so the name's owner answers 409.
    await expect(s.tools.deploy(s.scope(), { ...args, files: { "index.html": "b" } })).rejects.toMatchObject({ code: "conflict" });
    expect(first).toStartWith("ready:");
  });

  test("an explicit key reused with a different request is refused", async () => {
    const s = setup();
    await s.tools.deploy(s.scope(), { files: { "index.html": "a" }, name: "k1", visibility: "public", idempotencyKey: "same" });
    await expect(s.tools.deploy(s.scope(), { files: { "index.html": "a" }, name: "k2", visibility: "public", idempotencyKey: "same" })).rejects.toMatchObject({ code: "unprocessable" });
  });

  test("an image deploy; waitSeconds 0 returns at once with the URL and what to do next", async () => {
    const s = setup();
    const out = await s.tools.deploy(s.scope(), { image: "traefik/whoami:v1.10", port: 80, name: "who", visibility: "public", waitSeconds: 0 });
    expect(out).toMatch(/^still (building|starting|awake) after 0s: https:\/\/who\.preview\.localhost:8443\//);
    expect(out).toContain('Call status with preview "who"');
    await s.ctx.inflight.get(resolvePreview(s.ctx, "who").id)?.done;
  });

  test("a failed deploy says why and shows the end of the log", async () => {
    const s = setup();
    s.fake.buildExit = 1;
    const out = await s.tools.deploy(s.scope(), { files: { "index.html": "x" }, name: "broken", visibility: "public" });
    expect(out).toStartWith("failed:");
    expect(out).toContain("last log lines:");
    expect(out).toContain("load build definition from Dockerfile");
  });

  test("bad input is refused before anything starts", async () => {
    const s = setup();
    await expect(s.tools.deploy(s.scope(), {})).rejects.toThrow("exactly one of files, image or git");
    await expect(s.tools.deploy(s.scope(), { image: "nginx" })).rejects.toThrow("needs port");
    await expect(s.tools.deploy(s.scope(), { image: "nginx", port: 80, addons: ["postgres"] })).rejects.toThrow("addons go with files");
    await expect(s.tools.deploy(s.scope(), { files: { a: "" }, addons: ["mongo"] })).rejects.toThrow();
    await expect(s.tools.deploy(s.scope(), { files: { a: "" }, remove: ["b"] })).rejects.toThrow("remove only goes with preview");
    expect(s.ctx.previews.list({}).length).toBe(0);
  });

  test("preview + files rebuilds the same preview at the same URL; it needs previews.update", async () => {
    const s = setup();
    await s.tools.deploy(s.scope(), { files: { "index.html": "v1" }, name: "site", visibility: "public" });
    const id = resolvePreview(s.ctx, "site").id;
    const out = await s.tools.deploy(s.scope(), { preview: "site", files: { "about.html": "about" } });
    expect(out).toStartWith("ready: https://site.preview.localhost:8443/ (rebuilt)");
    expect(resolvePreview(s.ctx, "site").id).toBe(id);
    expect((await s.ctx.sources!.list(id)).files.map((f) => f.path).sort()).toEqual(["about.html", "index.html"]);

    const deployOnly = tokenActor("t-deploy", ["deploy"]) as Actor;
    await expect(s.tools.deploy(s.scope(deployOnly), { preview: "site", files: { "x.html": "" } })).rejects.toThrow('lacks the "previews.update" permission');
  });

  test("names: an unlisted preview answers to its stem; two matches is an error that lists both", async () => {
    const s = setup();
    await s.tools.deploy(s.scope(), { files: { "index.html": "a" }, name: "shop", visibility: "unlisted" });
    expect(await s.tools.status(s.scope(), "shop")).toMatch(/^shop-[a-z0-9]{10}: awake/);
    await s.tools.deploy(s.scope(), { files: { "index.html": "b" }, name: "shop", visibility: "unlisted" });
    await expect(s.tools.status(s.scope(), "shop")).rejects.toThrow("matches 2 previews");
    await expect(s.tools.status(s.scope(), "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(s.tools.status(s.scope(), "https://nope.preview.localhost/")).rejects.toMatchObject({ code: "not_found" });
  });

  test("a read-only credential may look but not touch", async () => {
    const s = setup();
    await s.tools.deploy(s.scope(), { files: { "index.html": "a" }, name: "ro", visibility: "public" });
    expect(await s.tools.status(s.scope(READ_ONLY), "ro")).toStartWith("ro: awake");
    await expect(s.tools.deploy(s.scope(READ_ONLY), { files: { "index.html": "a" } })).rejects.toThrow('"previews.deploy"');
    await expect(s.tools.destroy(s.scope(READ_ONLY), "ro")).rejects.toThrow('"previews.destroy"');
  });

  test("an abort (MCP switched off) ends the wait, not the deploy", async () => {
    const s = setup();
    s.fake.planDelayMs = 0;
    const abort = new AbortController();
    const pending = s.tools.deploy(s.scope(ACTOR, abort.signal), { image: "traefik/whoami:v1.10", port: 80, name: "cut", visibility: "public", waitSeconds: 60 });
    abort.abort();
    expect(await pending).toStartWith("stopped waiting: the MCP surface was switched off. The deploy carries on: https://cut.preview.localhost:8443/");
    const p = resolvePreview(s.ctx, "cut");
    expect((await s.ctx.inflight.get(p.id)?.done)?.state ?? s.ctx.previews.get(p.id)!.state).toBe("awake");
  });
});

/* ---------------------------------------------------------------- the surface */

const TOKEN = "gw_mcp_test_token_0123456789abcdefghijk";
const MODERN = "2026-07-28";
const ENVELOPE = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };

function surface() {
  const s = setup();
  const mcp = new McpSurface({ tools: s.tools, verifyToken: staticTokenVerifier(TOKEN), logger: quiet });
  const h = mcp.handler();
  const call = (init: { method?: string; path?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {}) =>
    Promise.resolve(h(new Request(`https://mcp.preview.localhost:8443${init.path ?? "/"}`, {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }), { clientIp: "203.0.113.9" }));
  /** The JSON-RPC messages in an SSE body. */
  const messages = async (res: Response) => (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { id?: number; result?: any; error?: any; method?: string });
  const modern = (id: number, method: string, params: Record<string, unknown> = {}) => call({
    body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...ENVELOPE, ...(params["_meta"] as object | undefined) } } },
    headers: { "mcp-protocol-version": MODERN, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": String(params["name"]) } : {}) },
  });
  return { ...s, mcp, call, messages, modern };
}

describe("the mcp surface", () => {
  test("no credential or a wrong one: 401 with a Bearer challenge; nothing reaches a tool", async () => {
    const s = surface();
    for (const token of [null, "gw_wrong"]) {
      const res = await s.call({ token, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toStartWith("Bearer");
    }
  });

  test("a browser request (any Origin) is 403; GET and DELETE are 405; other paths 404", async () => {
    const s = surface();
    expect((await s.call({ headers: { origin: "https://evil.preview.localhost:8443" }, body: {} })).status).toBe(403);
    expect((await s.call({ method: "GET" })).status).toBe(405);
    expect((await s.call({ method: "DELETE" })).status).toBe(405);
    expect((await s.call({ path: "/v1/previews", method: "GET" })).status).toBe(404);
  });

  test("2026-07-28: tools/list names exactly the four tools; a tools/call deploys and answers with the URL", async () => {
    const s = surface();
    const list = await s.messages(await s.modern(1, "tools/list"));
    expect(list.at(-1)!.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["deploy", "destroy", "logs", "status"]);

    const res = await s.modern(2, "tools/call", { name: "deploy", arguments: { files: { "index.html": "<p>modern</p>" }, name: "modern", visibility: "public" }, _meta: { progressToken: "p1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const msgs = await s.messages(res);
    expect(msgs.some((m) => m.method === "notifications/progress")).toBe(true);
    const result = msgs.find((m) => m.id === 2)!.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toStartWith("ready: https://modern.preview.localhost:8443/");
    expect(s.mcp.open).toBe(0);
  });

  test("2025-11-25: the initialize handshake, then a call; a refusal is a tool error the agent can read", async () => {
    const s = surface();
    const init = await s.messages(await s.call({ body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" } } } }));
    expect(init[0]!.result.serverInfo.name).toBe("gangway");
    const res = await s.messages(await s.call({ headers: { "mcp-protocol-version": "2025-11-25" }, body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: { preview: "ghost" } } } }));
    const result = res.find((m) => m.id === 2)!.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('status refused: no live preview is called "ghost"');
  });

  test("dropAll ends an open stream and the waiting tool gives up", async () => {
    const s = surface();
    s.fake.answering = false;
    const res = await s.modern(3, "tools/call", { name: "deploy", arguments: { image: "traefik/whoami:v1.10", port: 80, name: "slow", visibility: "public", waitSeconds: 60 } });
    expect(s.mcp.open).toBe(1);
    const body = res.body!.getReader();
    const drained = (async () => { for (;;) { const { done } = await body.read(); if (done) return; } })();
    // The tool is running: its deploy exists and is waiting for the URL to answer.
    for (let i = 0; i < 200 && s.ctx.previews.list({}).length === 0; i++) await Bun.sleep(5);
    const p = resolvePreview(s.ctx, "slow");
    s.mcp.dropAll();
    expect(s.mcp.open).toBe(0);
    await expect(drained).rejects.toThrow("switched off");
    await s.ctx.inflight.get(p.id)?.done;
  });
});
