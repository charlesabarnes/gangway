import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { renderTemplate } from "@gangway/shared/artifact/index";
import { dispatch, type DispatchDeps } from "../../src/net/dispatch.ts";
import { DEFAULT_LIMITS } from "../../src/net/limits.ts";
import { serveSite, type ServedSite } from "../../src/net/site.ts";
import { renderDist } from "../../src/previews/artifact-render.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { redeploy } from "../../src/previews/redeploy.ts";
import { runtimeLogs } from "../../src/previews/runtime-logs.ts";
import { SiteStore } from "../../src/previews/site.ts";
import { sleepPreview, sweepIdle } from "../../src/previews/sleep.ts";
import { diff } from "../../src/reconcile/diff.ts";
import type { RouteEntry } from "../../src/routing/table.ts";
import { tempDir } from "../helpers/db.ts";
import { silentLogger } from "../helpers/logger.ts";
import { ACTOR } from "../helpers/preview-context.ts";
import {
  fullLabels,
  mkContainer,
  mkInput,
  mkPreview,
  mkRoute,
  only,
} from "../helpers/reconcile-diff.ts";
import { deployFiles, edit, setupRuntimes, setupServed } from "../helpers/runtimes-fixtures.ts";

const DECK = renderTemplate({ template: "deck/pitch", accent: "teal" });
const SITE = { "index.html": "<h1>home</h1>", "about.html": "<p>about</p>", "a/b.css": "b{}" };

async function site(
  files: Record<string, string>,
  over: Partial<ServedSite> = {},
): Promise<ServedSite> {
  const dir = tempDir();
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, "root", name, ".."), { recursive: true });
    await writeFile(join(dir, "root", name), body);
  }
  await writeFile(join(dir, "kit-config.json"), '{"brand":false}\n');
  return { root: join(dir, "root"), dir, fallback: "spa", kit: false, ...over };
}

const get = (s: ServedSite, path: string, init: RequestInit = {}, unlisted = false) =>
  serveSite(new Request(`https://x.preview.example.com${path}`, init), s, {
    unlisted,
    kitDir: renderDist(),
  });

describe("the file server", () => {
  test("answers a file, an index, path.html, then the single-page fallback", async () => {
    const s = await site({ ...SITE, "docs/index.html": "<p>docs</p>" });
    expect(await (await get(s, "/")).text()).toBe("<h1>home</h1>");
    expect(await (await get(s, "/about")).text()).toBe("<p>about</p>");
    expect(await (await get(s, "/docs/")).text()).toBe("<p>docs</p>");
    const unknown = await get(s, "/some/route");
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe("<h1>home</h1>");
    const css = await get(s, "/a/b.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("redirects a directory without its slash, keeping the query", async () => {
    const res = await get(await site({ "docs/index.html": "d" }), "/docs?x=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/docs/?x=1");
  });

  test("a site with a 404.html answers it with a 404", async () => {
    const s = await site({ "index.html": "i", "404.html": "gone" }, { fallback: "404" });
    const res = await get(s, "/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("gone");
  });

  test("never leaves the site: encoded dot-dot, a symlink out, a backslash", async () => {
    const s = await site(SITE);
    await writeFile(join(s.dir, "secret.txt"), "secret");
    await symlink(join(s.dir, "secret.txt"), join(s.root, "link.txt"));
    // The URL parser folds an encoded ../ away before it reaches the server.
    expect(await (await get(s, "/%2e%2e/secret.txt")).text()).toBe("<h1>home</h1>");
    expect((await get(s, "/..%2fsecret.txt")).status).toBe(400);
    expect((await get(s, "/a%5c..%5c..%5csecret.txt")).status).toBe(400);
    const link = await get(s, "/link.txt");
    expect(await link.text()).not.toContain("secret");
  });

  test("only GET and HEAD, and HEAD has no body", async () => {
    const s = await site(SITE);
    const post = await get(s, "/", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const head = await get(s, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("an unchanged file is a 304, and an unlisted preview is noindex", async () => {
    const s = await site(SITE);
    const first = await get(s, "/", {}, true);
    expect(first.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const again = await get(s, "/", { headers: { "if-none-match": first.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });

  test("gzips text for a client that takes it", async () => {
    const big = "x".repeat(5000);
    const res = await get(await site({ "big.txt": big }), "/big.txt", {
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString()).toBe(big);
  });

  test("a kit site gets the kit and its own config at /_gangway/; a plain site does not", async () => {
    const kit = await site(SITE, { kit: true });
    const js = await get(kit, "/_gangway/kit.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("max-age");
    expect(await (await get(kit, "/_gangway/config.json")).text()).toBe('{"brand":false}\n');
    expect((await get(kit, "/_gangway/nope.js")).status).toBe(404);
    expect(await (await get(await site(SITE), "/_gangway/kit.js")).text()).toBe("<h1>home</h1>");
  });
});

describe("deploying files gangway serves", () => {
  test("an artifact.md is served with no build, no container and a generated page", async () => {
    const s = setupServed();
    const res = await deployFiles(s, DECK, "auto", "deck");
    const done = await res.done;
    expect(done.state).toBe("awake");
    expect(done.source).toMatchObject({ kind: "tarball", runtime: "static", serve: "gangway" });
    expect(s.fake.builds).toBe(0);
    expect(s.fake.ups).toBe(0);
    expect(s.fake.all.filter((a) => a.includes("config"))).toEqual([]);
    expect(s.table.forPreview(res.preview.id)[0]!.site).toBe(true);
    const opened = (await s.sites.open(res.preview.id))!;
    expect(opened.kit).toBe(true);
    const page = await (await get(opened, "/")).text();
    expect(page).toContain("/_gangway/kit.js");
    const log = s.ctx.logs.read(res.preview.id).map((l) => l.line);
    expect(log.some((l) => l.startsWith("serving ") && l.includes("from gangway"))).toBe(true);
  });

  test("a plain static site is served too, on the route a container would get", async () => {
    const s = setupServed();
    const res = await deployFiles(s, SITE, "auto", "plain");
    expect((await res.done).state).toBe("awake");
    expect(s.routes.forPreview(res.preview.id)[0]).toMatchObject({
      service: "web",
      containerPort: 8080,
    });
    expect((await s.sites.open(res.preview.id))!.kit).toBe(false);
  });

  test("a site with no index.html still gets nginx, for its directory listing", async () => {
    const s = setupServed();
    const res = await deployFiles(s, { "notes.txt": "n" }, "static", "listing");
    const done = await res.done;
    expect(done.source).not.toHaveProperty("serve");
    expect(s.fake.builds).toBe(1);
  });

  test("with previews.serveStatic off, static sites go back to containers", async () => {
    const s = setupServed();
    s.ctx.serveStatic = () => false;
    const done = await (await deployFiles(s, SITE, "auto", "off")).done;
    expect(done.source).not.toHaveProperty("serve");
    expect(s.fake.ups).toBeGreaterThan(0);
  });

  test("an edit swaps the files in place without a container", async () => {
    const s = setupServed();
    const res = await deployFiles(s, SITE, "auto", "edited");
    await res.done;
    const outcome = await edit(s, res.preview.id, { "index.html": "<h1>v2</h1>" });
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.preview.state).toBe("awake");
    expect(s.fake.ups).toBe(0);
    const opened = (await s.sites.open(res.preview.id))!;
    expect(await (await get(opened, "/")).text()).toBe("<h1>v2</h1>");
  });

  test("an edit that needs a container is refused, and the files keep serving", async () => {
    const s = setupServed();
    const res = await deployFiles(s, SITE, "auto", "grows");
    await res.done;
    await expect(
      redeploy(s.ctx, {
        actor: ACTOR,
        previewId: res.preview.id,
        change: {
          kind: "edit",
          files: { "package.json": '{"scripts":{"start":"node s.js"}}', "s.js": "" },
        },
        runtime: "node",
      }),
    ).rejects.toMatchObject({ code: "unprocessable" });
    const opened = (await s.sites.open(res.preview.id))!;
    expect(await (await get(opened, "/")).text()).toBe("<h1>home</h1>");
  });

  test("a rebuild moves a static preview off its container onto the file server", async () => {
    const s = setupRuntimes();
    const res = await deployFiles(s, SITE, "auto", "moved");
    await res.done;
    expect(res.preview.source).not.toHaveProperty("serve");
    s.ctx.sites = new SiteStore(s.stateDir);
    const outcome = await edit(s, res.preview.id, { "about.html": "<p>new</p>" });
    expect(outcome.outcome).toBe("succeeded");
    expect(s.previews.get(res.preview.id)!.source).toMatchObject({ serve: "gangway" });
    expect(s.table.forPreview(res.preview.id)[0]!.site).toBe(true);
    expect(s.fake.downs).toContain(res.preview.project);
  });

  test("destroy removes the files and asks compose for nothing", async () => {
    const s = setupServed();
    const res = await deployFiles(s, SITE, "auto", "gone");
    await res.done;
    await destroy(s.ctx, res.preview.id, ACTOR);
    expect(s.fake.downs).toEqual([]);
    expect(await s.sites.has(res.preview.id)).toBe(false);
    expect(await s.sources.has(res.preview.id)).toBe(false);
  });

  test("a served preview never sleeps and has no runtime logs", async () => {
    const s = setupServed();
    const res = await deployFiles(s, SITE, "auto", "awake");
    const done = await res.done;
    s.clock.offset = 365 * 86_400_000;
    const report = await sweepIdle(s.ctx, silentLogger());
    expect(report.slept).toEqual([]);
    await expect(sleepPreview(s.ctx, done.id, "test")).rejects.toMatchObject({ code: "conflict" });
    expect(await runtimeLogs(s.ctx, done, { tail: 10 })).toMatchObject({ lines: null });
  });
});

describe("the reconciler and a served preview", () => {
  const served = { kind: "tarball", uploadId: "p1", runtime: "static", serve: "gangway" } as const;

  test("an awake one is left alone with no container to find", () => {
    const a = diff(
      mkInput({
        dbRoutes: [mkRoute("p1.example.com", "p1", 40000)],
        previews: [mkPreview("p1", "awake", { source: served })],
        hostReachable: false,
      }),
    );
    expect(a).toEqual([
      expect.objectContaining({ kind: "LeaveAlone", reason: "served-by-gangway" }),
    ]);
  });

  test("one a restart caught mid-publish is failed", () => {
    const a = diff(
      mkInput({
        dbRoutes: [mkRoute("p1.example.com", "p1", 40000)],
        previews: [mkPreview("p1", "building", { source: served })],
      }),
    );
    expect(only(a, "MarkFailed")).toMatchObject({ previewId: "p1" });
  });

  test("a container still labelled with its hostname is stopped", () => {
    const a = diff(
      mkInput({
        dbRoutes: [mkRoute("p1.example.com", "p1", 40000)],
        previews: [mkPreview("p1", "awake", { source: served })],
        containers: [mkContainer("c1", fullLabels("p1", "p1.example.com"))],
      }),
    );
    expect(only(a, "StopOrphan")).toMatchObject({ reason: "hostname-conflict" });
  });
});

describe("dispatch", () => {
  test("hands a site route to the file server, not the upstream", async () => {
    const entry = {
      hostname: "p1.preview.example.com",
      previewId: "p1",
      hostId: "local",
      project: "gw-p1",
      service: "web",
      containerPort: 80,
      upstreamHost: "127.0.0.1",
      upstreamPort: 31000,
      primary: true,
      visibility: "public",
      password: { mode: "inherit" },
      passwordLogin: "inherit",
      state: "awake",
      site: true,
      inflight: 0,
      bytesInFlight: 0,
      lastSeenAt: 0,
    } satisfies RouteEntry;
    let proxied = 0;
    let seen = 0;
    const deps: DispatchDeps = {
      baseDomain: () => "preview.example.com",
      table: { lookup: () => entry } as never,
      upstream: {
        fetch: () => {
          proxied++;
          return Promise.resolve(new Response("proxied"));
        },
      } as never,
      limits: DEFAULT_LIMITS,
      surfaceEnabled: () => true,
      handlers: {},
      clientIpFor: () => "1.2.3.4",
      site: () => Promise.resolve(new Response("from files")),
      onProxied: () => seen++,
    };
    const res = await dispatch(
      new Request(`https://${entry.hostname}/`, { headers: { host: entry.hostname } }),
      deps,
    );
    expect(await res.text()).toBe("from files");
    expect(proxied).toBe(0);
    expect(seen).toBe(1);
    expect(entry.inflight).toBe(0);
  });
});
