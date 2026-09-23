/**
 * ADR-0021 upload by reference: `deploy` with `upload: "new"` hands out a one-use URL, the
 * agent's shell PUTs a tar.gz there, and `deploy` with `upload: <id>` builds those bytes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { McpSurface } from "../../src/app/mcp-surface.ts";
import { staticTokenVerifier, tokenActor, type Actor } from "../../src/auth/actor.ts";
import { IdempotencyRepo } from "../../src/db/repos/index.ts";
import { Logger } from "../../src/logger.ts";
import { packFiles } from "../../src/mcp/pack.ts";
import { resolvePreview } from "../../src/mcp/resolve.ts";
import { Tools, type CallScope } from "../../src/mcp/tools.ts";
import { Uploads } from "../../src/mcp/uploads.ts";
import { IdempotentDeploys } from "../../src/previews/idempotent.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

const quiet = new Logger("error", {}, () => {});
const TOKEN = "gw_uploads_test_token_0123456789abcdef";

function setup(o: { maxBytes?: number } = {}) {
  const s = setupPreviewContext();
  s.ctx.sources = new SourceStore(dirname(s.ctx.workdirs.root));
  const dir = mkdtempSync(join(tmpdir(), "gangway-uploads-"));
  const uploads = new Uploads({
    dir,
    url: (id) => `https://mcp.preview.localhost:8443/uploads/${id}`,
    now: s.ctx.now,
    ...o,
  });
  const tools = new Tools({
    ctx: s.ctx,
    deploys: new IdempotentDeploys(s.ctx, new IdempotencyRepo(s.db, s.ctx.now)),
    uploads,
    logger: quiet,
  });
  const mcp = new McpSurface({
    tools,
    uploads,
    verifyToken: staticTokenVerifier(TOKEN),
    logger: quiet,
  }).handler();
  const scope = (actor: Actor = ACTOR): CallScope => ({
    actor,
    signal: new AbortController().signal,
  });
  const put = (url: string, body: Uint8Array | null, headers: Record<string, string> = {}) =>
    Promise.resolve(
      mcp(
        new Request(url, {
          method: "PUT",
          body,
          headers: { "content-type": "application/gzip", ...headers },
        }),
        { clientIp: "203.0.113.9" },
      ),
    );
  const idOf = (text: string) => /upload: "([A-Za-z0-9_-]{43})"/.exec(text)![1]!;
  const urlOf = (text: string) => /'(https:\/\/mcp\.[^']+)'/.exec(text)![1]!;
  return { ...s, dir, uploads, tools, scope, put, idOf, urlOf };
}

describe("upload by reference", () => {
  test("new -> PUT -> deploy: the preview is exactly the uploaded bytes, and nothing is left on disk", async () => {
    const s = setup();
    const offer = await s.tools.deploy(s.scope(), { upload: "new" });
    expect(offer).toContain("tar --exclude=.git --exclude=node_modules -czf - . | curl");
    expect(s.ctx.previews.list({}).length).toBe(0);
    const { archive } = await packFiles({ "index.html": "<h1>from disk</h1>", "css/a.css": "a{}" });
    const res = await s.put(s.urlOf(offer), archive);
    expect(res.status).toBe(201);
    expect(await res.text()).toMatch(/^received \d+ bytes, sha256 [0-9a-f]{64}/);

    const out = await s.tools.deploy(s.scope(), {
      upload: s.idOf(offer),
      name: "big",
      visibility: "public",
    });
    expect(out).toStartWith("ready: https://big.preview.localhost:8443/");
    expect(out).toContain("css/a.css");
    const id = resolvePreview(s.ctx, "big").id;
    expect((await s.ctx.sources!.list(id)).files.map((f) => f.path)).toEqual([
      "css/a.css",
      "index.html",
    ]);
    expect(readdirSync(s.dir)).toEqual([]);
    // One use.
    await expect(
      s.tools.deploy(s.scope(), { upload: s.idOf(offer), name: "again", visibility: "public" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await s.put(s.urlOf(offer), archive)).status).toBe(404);
  });

  test("preview + upload replaces the whole source and rebuilds at the same URL", async () => {
    const s = setup();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "v1", "old.html": "gone soon" },
      name: "site",
      visibility: "public",
    });
    const offer = await s.tools.deploy(s.scope(), { upload: "new" });
    await s.put(s.urlOf(offer), (await packFiles({ "index.html": "v2" })).archive);
    const out = await s.tools.deploy(s.scope(), { preview: "site", upload: s.idOf(offer) });
    expect(out).toContain("(rebuilt)");
    expect(
      (await s.ctx.sources!.list(resolvePreview(s.ctx, "site").id)).files.map((f) => f.path),
    ).toEqual(["index.html"]);
    await expect(
      s.tools.deploy(s.scope(), { preview: "site", upload: "x", files: { a: "" } }),
    ).rejects.toThrow("one or the other");
  });

  test("only the credential that asked may deploy it; nothing sent yet is a clear error", async () => {
    const s = setup();
    const offer = await s.tools.deploy(s.scope(), { upload: "new" });
    await expect(
      s.tools.deploy(s.scope(), { upload: s.idOf(offer), name: "early" }),
    ).rejects.toThrow("nothing has been sent");
    await s.put(s.urlOf(offer), (await packFiles({ "index.html": "x" })).archive);
    const stranger = tokenActor("t-other", ["deploy"]);
    await expect(
      s.tools.deploy(s.scope(stranger), { upload: s.idOf(offer), name: "stolen" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await s.tools.deploy(s.scope(), {
        upload: s.idOf(offer),
        name: "mine",
        visibility: "public",
      }),
    ).toStartWith("ready:");
  });

  test("the PUT: a cap on bytes, no browsers, no second PUT, unknown ids 404, and a read credential cannot ask", async () => {
    const s = setup({ maxBytes: 1024 });
    const offer = await s.tools.deploy(s.scope(), { upload: "new" });
    const url = s.urlOf(offer);
    expect((await s.put(url, new Uint8Array(2048))).status).toBe(413);
    expect((await s.put(url, new Uint8Array(10), { origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await s.put(url, new Uint8Array(10))).status).toBe(201);
    expect((await s.put(url, new Uint8Array(10))).status).toBe(409);
    expect((await s.put(url.replace(/[^/]+$/, "A".repeat(43)), new Uint8Array(10))).status).toBe(
      404,
    );
    expect((await s.put(url.replace(/[^/]+$/, "..%2F..%2Fetc"), new Uint8Array(10))).status).toBe(
      404,
    );
    await expect(
      s.tools.deploy(s.scope(tokenActor("t-r", ["read"])), { upload: "new" }),
    ).rejects.toThrow('"previews.deploy"');
  });

  test("a slot expires, and its bytes go with it", async () => {
    const s = setup();
    const offer = await s.tools.deploy(s.scope(), { upload: "new" });
    await s.put(s.urlOf(offer), (await packFiles({ "index.html": "x" })).archive);
    expect(readdirSync(s.dir).length).toBe(1);
    s.clock.offset += 16 * 60_000;
    await expect(
      s.tools.deploy(s.scope(), { upload: s.idOf(offer), name: "late" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(readdirSync(s.dir)).toEqual([]);
  });

  test("without an upload store, upload is refused and files still work", async () => {
    const s = setupPreviewContext();
    const tools = new Tools({
      ctx: s.ctx,
      deploys: new IdempotentDeploys(s.ctx, new IdempotencyRepo(s.db, s.ctx.now)),
      logger: quiet,
    });
    await expect(
      tools.deploy({ actor: ACTOR, signal: new AbortController().signal }, { upload: "new" }),
    ).rejects.toThrow("send files instead");
  });
});
