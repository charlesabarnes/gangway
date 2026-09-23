/** ADR-0015: runtimes, the kept source, and rebuilding a preview in place (fake compose, real files). */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { pack } from "tar-stream";
import { DETECTION, RUNTIMES, detectRuntime } from "../../../shared/src/runtimes.ts";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { runtimeRoutes } from "../../src/app/routes/runtimes.ts";
import { Logger } from "../../src/logger.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { checkEditPath, redeploy } from "../../src/previews/redeploy.ts";
import { planRuntime, resolveRuntime, writeRuntime } from "../../src/previews/runtimes.ts";
import { asText, SourceStore } from "../../src/previews/source/store.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

async function tarball(files: Record<string, string>): Promise<Uint8Array> {
  const p = pack();
  for (const [name, content] of Object.entries(files)) p.entry({ name }, content);
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const c of p) chunks.push(c as Buffer);
  return gzipSync(Buffer.concat(chunks));
}

async function folder(files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gangway-rt-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** The harness with a kept-source store, as boot wires it. */
function setup() {
  const s = setupPreviewContext();
  const stateDir = dirname(s.ctx.workdirs.root);
  s.ctx.sources = new SourceStore(stateDir);
  return { ...s, sources: s.ctx.sources, stateDir };
}

describe("detection", () => {
  test.each([
    [["compose.yaml", "package.json"], "own"],
    [["Dockerfile", "index.html"], "own"],
    [["wrangler.toml", "package.json"], "workerd"],
    [["deno.json", "main.ts"], "deno"],
    [["bun.lock", "package.json"], "bun"],
    [["package.json", "index.ts"], "node"],
    [["requirements.txt"], "python"],
    [["index.php"], "php"],
    [["index.ts"], "bun"],
    [["index.html", "style.css"], "static"],
    [[], "static"],
  ])("%j -> %s", (paths, want) => expect(detectRuntime(paths)).toBe(want as never));

  test("the server reads the same markers from disk", async () => {
    const dir = await folder({ "deno.json": "{}", "main.ts": "" });
    expect(await resolveRuntime(dir, "auto")).toBe("deno");
    expect(await resolveRuntime(dir, "static")).toBe("static");
    rmSync(dir, { recursive: true });
  });

  test("every starter is detected as its own runtime (deno's main.ts alone reads as Bun's; the UI posts starters with ?runtime=)", () => {
    for (const rt of RUNTIMES) {
      const got = detectRuntime(Object.keys(rt.starter));
      if (rt.id === "deno") expect(got).toBe("bun");
      else expect(got).toBe(rt.id);
    }
  });
});

describe("generated build files", () => {
  test("a port override reaches every runtime's listener", async () => {
    const dir = await folder({ "index.html": "", "index.php": "", "src/index.ts": "" });
    expect((await planRuntime(dir, "static", [], 3000)).files["nginx.conf"]).toContain("listen 3000;");
    expect((await planRuntime(dir, "php", [], 3000)).dockerfile).toContain("Listen 3000");
    expect((await planRuntime(dir, "workerd", [], 3000)).files["bundle.cjs"]).toContain("*:3000");
    expect((await planRuntime(dir, "php")).dockerfile).not.toContain("sed");
    rmSync(dir, { recursive: true });
  });

  test("every runtime plans a Dockerfile from its starter, FROM its pinned image", async () => {
    for (const rt of RUNTIMES) {
      const dir = await folder(rt.starter);
      const plan = await planRuntime(dir, rt.id, ["API_KEY"]);
      expect(plan.dockerfile).toContain(rt.id === "workerd" ? "FROM node:24-bookworm-slim" : `FROM ${rt.image}`);
      expect(plan.dockerfile).toContain(`ENV PORT=${rt.port}`);
      rmSync(dir, { recursive: true });
    }
  });

  test("every generated script parses (found live: a quoting slip broke workerd's bundler)", async () => {
    const ts = new Bun.Transpiler({ loader: "ts" });
    for (const rt of RUNTIMES) {
      const dir = await folder(rt.starter);
      const plan = await planRuntime(dir, rt.id, ["API_KEY", "PUBLIC_URL"]);
      for (const [name, code] of Object.entries(plan.files)) {
        if (name.endsWith(".cjs")) expect(() => new Function("require", code)).not.toThrow();
        if (name.endsWith(".ts")) expect(() => ts.transformSync(code)).not.toThrow();
      }
      rmSync(dir, { recursive: true });
    }
  });

  test("an entry file is required where the runtime has one, and said which", async () => {
    const dir = await folder({ "README.md": "hi" });
    await expect(planRuntime(dir, "bun")).rejects.toMatchObject({ code: "unprocessable", message: expect.stringContaining("index.ts") });
    await expect(planRuntime(dir, "node")).rejects.toMatchObject({ message: expect.stringContaining("`start` script") });
    rmSync(dir, { recursive: true });
  });

  test("node: a start script wins; else package.json main; a main that escapes is ignored", async () => {
    const a = await folder({ "package.json": JSON.stringify({ scripts: { start: "node x.js" } }) });
    expect((await planRuntime(a, "node")).dockerfile).toContain(`CMD ["npm", "start"]`);
    const b = await folder({ "package.json": JSON.stringify({ main: "srv/app.js" }), "srv/app.js": "" });
    expect((await planRuntime(b, "node")).dockerfile).toContain(`CMD ["node", "srv/app.js"]`);
    const c = await folder({ "package.json": JSON.stringify({ main: "../../etc/passwd" }) });
    await expect(planRuntime(c, "node")).rejects.toMatchObject({ code: "unprocessable" });
    for (const d of [a, b, c]) rmSync(d, { recursive: true });
  });

  test("static: SPA fallback with index.html, 404.html beats it, a listing with neither", async () => {
    const spa = await folder({ "index.html": "" });
    expect((await planRuntime(spa, "static")).files["nginx.conf"]).toContain("try_files $uri $uri/ $uri.html /index.html;");
    const nf = await folder({ "index.html": "", "404.html": "" });
    expect((await planRuntime(nf, "static")).files["nginx.conf"]).toContain("error_page 404 /404.html;");
    const bare = await folder({ "a.txt": "" });
    expect((await planRuntime(bare, "static")).files["nginx.conf"]).toContain("autoindex on;");
    for (const d of [spa, nf, bare]) rmSync(d, { recursive: true });
  });

  test("workerd: wrangler's main is the entry; secrets are bound by NAME, never value", async () => {
    const dir = await folder({ "wrangler.toml": 'main = "src/w.ts"\n', "src/w.ts": "" });
    const plan = await planRuntime(dir, "workerd", ["API_KEY"]);
    expect(plan.files["bundle.cjs"]).toContain('const ENTRY = "src/w.ts"');
    expect(plan.files["bundle.cjs"]).toContain('["API_KEY"]');
    rmSync(dir, { recursive: true });
  });

  test("writeRuntime: .gangway/ in the context, the compose file (with secret VALUES) outside it", async () => {
    const dir = await folder({ "index.ts": "" });
    const out = mkdtempSync(join(tmpdir(), "gangway-rt-out-"));
    const { composeFile } = await writeRuntime(dir, "bun", { API_KEY: "s3cret" }, join(out, "c.yaml"));
    expect(existsSync(join(dir, ".gangway/Dockerfile"))).toBe(true);
    expect(existsSync(join(dir, ".gangway/entry.ts"))).toBe(true);
    expect(readFileSync(join(dir, ".gangway/Dockerfile.dockerignore"), "utf8")).toContain("node_modules");
    // Found live: nginx runs unprivileged and could not read a 0600 config.
    expect(statSync(join(dir, ".gangway/Dockerfile")).mode & 0o777).toBe(0o644);
    expect(statSync(join(out, "c.yaml")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, composeFile), "utf8")).toContain("s3cret");
    expect(composeFile.startsWith("..")).toBe(true);
    await expect(writeRuntime(dir, "bun", {}, join(dir, "inside.yaml"))).rejects.toMatchObject({ code: "internal" });
    for (const d of [dir, out]) rmSync(d, { recursive: true });
  });

  test("asText: UTF-8 yes, NUL or invalid bytes no", () => {
    expect(asText(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(asText(new Uint8Array([0x68, 0, 0x69]))).toBeNull();
    expect(asText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});

describe("deploying with a runtime", () => {
  test("auto-detected, built from .gangway/Dockerfile, named <runtime>-xxxx, the upload KEPT without .gangway/", async () => {
    const s = setup();
    const archive = await tarball({ "index.ts": "export default { fetch: () => new Response('hi') }", ".gangway/evil": "x" });
    const res = await deploy(s.ctx, { actor: ACTOR, visibility: "public", source: { kind: "tarball", archive, runtime: "auto" } });
    expect(res.preview.source).toEqual({ kind: "tarball", uploadId: res.preview.id, runtime: "bun" });
    expect(res.preview.project).toMatch(/-bun-[a-z0-9]{4}$/);
    expect((await res.done).state).toBe("awake");
    expect(s.routes.forPreview(res.preview.id)[0]).toMatchObject({ service: "web", containerPort: 3000 });
    const listing = await s.sources.list(res.preview.id);
    expect(listing.files.map((f) => f.path)).toEqual(["index.ts"]);
    expect(listing.files[0]!.text).toContain("export default");
    const log = s.ctx.logs.read(res.preview.id).map((l) => l.line);
    expect(log).toContain("detected runtime bun: bun index.ts");
  });

  test("two runtime deploys with no name do not collide", async () => {
    const s = setup();
    const a = await deploy(s.ctx, { actor: ACTOR, visibility: "public", source: { kind: "tarball", archive: await tarball({ "index.html": "" }), runtime: "static" } });
    const b = await deploy(s.ctx, { actor: ACTOR, visibility: "public", source: { kind: "tarball", archive: await tarball({ "index.html": "" }), runtime: "static" } });
    expect(a.preview.project).not.toBe(b.preview.project);
    await Promise.all([a.done, b.done]);
  });

  test("a plan failure keeps nothing", async () => {
    const s = setup();
    await expect(deploy(s.ctx, { actor: ACTOR, visibility: "public", source: { kind: "tarball", archive: await tarball({ "README.md": "" }), runtime: "python" } }))
      .rejects.toMatchObject({ code: "unprocessable" });
    expect(await s.sources.ids()).toEqual([]);
  });

  test("destroy removes the kept source", async () => {
    const s = setup();
    const res = await deploy(s.ctx, { actor: ACTOR, name: "gone", visibility: "public", source: { kind: "tarball", archive: await tarball({ "index.html": "" }), runtime: "static" } });
    await res.done;
    expect(await s.sources.has(res.preview.id)).toBe(true);
    await destroy(s.ctx, res.preview.id, ACTOR);
    expect(await s.sources.has(res.preview.id)).toBe(false);
  });
});

describe("rebuilding in place", () => {
  async function live(s: ReturnType<typeof setup>, files: Record<string, string> = { "index.ts": "v1" }) {
    const res = await deploy(s.ctx, { actor: ACTOR, name: "edit", visibility: "public", source: { kind: "tarball", archive: await tarball(files), runtime: "bun" } });
    return (await res.done);
  }

  test("an edit: same preview, same route, new source kept, awake again, events and audit", async () => {
    const s = setup();
    const p = await live(s);
    const before = s.routes.forPreview(p.id);
    const res = await redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: { kind: "edit", files: { "index.ts": "v2", "lib/util.ts": "export {}" } } });
    const o = await res.done;
    expect(o).toMatchObject({ outcome: "succeeded", preview: { id: p.id, state: "awake" } });
    expect(s.routes.forPreview(p.id)).toEqual(before);
    const kept = await s.sources.list(p.id);
    expect(kept.files.map((f) => [f.path, f.text])).toEqual([["index.ts", "v2"], ["lib/util.ts", "export {}"]]);
    expect(s.fake.builds).toBe(2);
    const events = s.ctx.bus.history(p.id).filter((e) => e.type === "preview.redeploy").map((e) => e.payload["phase"]);
    expect(events).toEqual(["started", "succeeded"]);
    const states = s.ctx.bus.history(p.id).filter((e) => e.type === "preview.state").map((e) => e.payload["state"]);
    expect(states.slice(-2)).toEqual(["starting", "awake"]);
  });

  test("a failed build leaves the old version serving (still awake) and keeps the new source", async () => {
    const s = setup();
    const p = await live(s);
    s.fake.buildExit = 1;
    const o = await (await redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: { kind: "edit", files: { "index.ts": "broken" } } })).done;
    expect(o).toMatchObject({ outcome: "failed", error: "compose build exited 1", preview: { state: "awake" } });
    expect((await s.sources.list(p.id)).files[0]!.text).toBe("broken");
    expect(s.ctx.builds!.forPreview(p.id).map((b) => b.state)).toContain("failed");
  });

  test("a failed preview recovers with the next save", async () => {
    const s = setup();
    s.fake.answering = false;
    const p = await live(s);
    expect(p.state).toBe("failed");
    s.fake.answering = true;
    const o = await (await redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: { kind: "edit", files: { "index.ts": "fixed" } } })).done;
    expect(o).toMatchObject({ outcome: "succeeded", preview: { state: "awake" } });
  });

  test("a replacement upload and a runtime change are recorded on the preview", async () => {
    const s = setup();
    const p = await live(s);
    const o = await (await redeploy(s.ctx, { actor: ACTOR, previewId: p.id, runtime: "deno", change: { kind: "replace", archive: await tarball({ "main.ts": "x" }) } })).done;
    // deno's own port is 8000; the rebuild keeps the preview's 3000 and tells deno to listen there.
    expect(o.outcome).toBe("succeeded");
    expect(s.previews.get(p.id)!.source).toMatchObject({ runtime: "deno" });
    expect(s.routes.forPreview(p.id)[0]).toMatchObject({ containerPort: 3000 });
  }, 10_000);

  test("refusals change nothing: bad paths, .gangway/, a different port, a busy preview, a non-upload", async () => {
    const s = setup();
    const p = await live(s);
    for (const bad of ["../x", "/etc/passwd", "a//b", ".gangway/Dockerfile", "a\\b", ""]) expect(() => checkEditPath(bad)).toThrow();
    await expect(redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: { kind: "edit", files: { "../x": "1" } } })).rejects.toMatchObject({ code: "unprocessable" });
    // An own compose file routing a different port is a different preview.
    await expect(redeploy(s.ctx, { actor: ACTOR, previewId: p.id, runtime: "own", change: { kind: "edit", files: { "compose.yaml": "services:\n  web:\n    image: nginx\n    x-gangway: { expose: true, port: 80 }\n" } } }))
      .rejects.toMatchObject({ code: "unprocessable", message: expect.stringContaining("different services or ports") });
    expect((await s.sources.list(p.id)).files.map((f) => f.path)).toEqual(["index.ts"]);
    expect(s.ctx.inflight.size).toBe(0);

    const first = await redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: { kind: "edit", files: { "index.ts": "a" } } });
    await expect(redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: { kind: "edit", files: { "index.ts": "b" } } })).rejects.toMatchObject({ code: "conflict" });
    await first.done;

    const img = await s.deployed("image");
    await expect(redeploy(s.ctx, { actor: ACTOR, previewId: img.id, change: { kind: "edit", files: { a: "" } } })).rejects.toMatchObject({ code: "conflict" });
  });

  test("destroy during a rebuild aborts it", async () => {
    const s = setup();
    const p = await live(s);
    s.fake.planDelayMs = 0;
    const res = await redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: { kind: "edit", files: { "index.ts": "z" } } });
    await destroy(s.ctx, p.id, ACTOR);
    await res.done;
    expect(s.previews.get(p.id)!.state).toBe("destroyed");
  });
});

describe("HTTP", () => {
  const quiet = new Logger("error", {}, () => {});
  const api = (s: ReturnType<typeof setup>) => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(quiet));
    app.use(async (c, next) => { c.set("requestId", "r"); c.set("actor", ACTOR); return next(); });
    previewRoutes(app, s.ctx, null as never);
    runtimeRoutes(app);
    return app;
  };

  test("GET /runtimes: the catalogue and the detection rules", async () => {
    const body = await (await api(setup()).request("/runtimes")).json() as { runtimes: { id: string; entries?: unknown }[]; detection: unknown };
    expect(body.runtimes.map((r) => r.id)).toEqual(RUNTIMES.map((r) => r.id));
    expect(body.runtimes[0]!.entries).toBeUndefined();
    expect(body.detection).toEqual(JSON.parse(JSON.stringify(DETECTION)));
  });

  test("source: 404 for an image preview; listed for an upload; PATCH ?wait rebuilds; PUT needs a tarball", async () => {
    const s = setup();
    const app = api(s);
    const img = await s.deployed("img");
    expect((await app.request(`/previews/${img.id}/source`)).status).toBe(404);

    const up = await deploy(s.ctx, { actor: ACTOR, name: "up", visibility: "public", source: { kind: "tarball", archive: await tarball({ "index.html": "<h1>1</h1>" }), runtime: "static" } });
    await up.done;
    const src = await (await app.request(`/previews/${up.preview.id}/source`)).json();
    expect(src).toEqual({ runtime: "static", files: [{ path: "index.html", size: 10, text: "<h1>1</h1>" }], truncated: false });

    const patched = await app.request(`/previews/${up.preview.id}/source?wait=true`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: { "index.html": "<h1>2</h1>" } }) });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ outcome: "succeeded", preview: { id: up.preview.id, state: "awake" } });

    const accepted = await app.request(`/previews/${up.preview.id}/source?runtime=own`, { method: "PUT", headers: { "content-type": "application/gzip" }, body: await tarball({ "Dockerfile": "FROM nginx" }) });
    // An own Dockerfile gets the port the preview already routes to.
    expect(accepted.status).toBe(202);
    const body = await accepted.json() as { buildId: string; preview: { id: string } };
    expect(Object.keys(body).sort()).toEqual(["buildId", "preview"]);
    await s.ctx.inflight.get(up.preview.id)?.done;

    expect((await app.request(`/previews/${up.preview.id}/source`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  });
});
