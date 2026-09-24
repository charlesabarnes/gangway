import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { tokenActor, type Actor } from "../../src/auth/actor.ts";
import { resolvePreview } from "../../src/mcp/resolve.ts";
import { offeredScopes } from "../../src/oauth/scopes.ts";
import { redeploy } from "../../src/previews/redeploy.ts";
import { SiteStore } from "../../src/previews/site.ts";
import { tempDir } from "../helpers/db.ts";
import { silentLogger } from "../helpers/logger.ts";
import { setupTools } from "../helpers/mcp-tools.ts";

const as = (tokenId: string, scopes: Parameters<typeof tokenActor>[1], userId = "ada") =>
  ({ ...tokenActor(tokenId, scopes), userId }) as Actor;

function served() {
  const s = setupTools();
  s.ctx.sites = new SiteStore(tempDir());
  return s;
}

const PAGE = { "index.html": "<h1>hi</h1>" };
const APP = {
  "package.json": JSON.stringify({ name: "app", scripts: { start: "node server.js" } }),
  "server.js": "require('http').createServer((q, r) => r.end('hi')).listen(3000)",
};

describe("the artifacts scope", () => {
  test("deploys what gangway serves itself, and nothing that needs a container", async () => {
    const s = served();
    const agent = as("oauth:g1", ["artifacts"]);
    expect(
      await s.tools.deploy(s.scope(agent), { files: PAGE, name: "page", visibility: "public" }),
    ).toStartWith("ready: https://page.preview.localhost:8443/");
    expect(
      await s.tools.deploy(s.scope(agent), {
        artifact: { template: "deck/pitch" },
        name: "deck",
        visibility: "public",
      }),
    ).toStartWith("ready:");

    await expect(
      s.tools.deploy(s.scope(agent), { image: "nginx", port: 80, name: "img" }),
    ).rejects.toThrow(
      "deploying from image needs a container, and this credential may deploy only artifacts",
    );
    await expect(
      s.tools.deploy(s.scope(agent), {
        git: { repo: "https://github.com/a/b", ref: "main" },
        name: "g",
      }),
    ).rejects.toThrow("needs a container");
    await expect(
      s.tools.deploy(s.scope(agent), { files: APP, name: "app", visibility: "public" }),
    ).rejects.toThrow("this source needs a container");
    expect(
      s.ctx.previews
        .list({})
        .map((p) => p.project)
        .sort(),
    ).toEqual(["gw-default-deck", "gw-default-page"]);
  });

  test("a static page may not be rebuilt into an app, nor an app of its person's rebuilt", async () => {
    const s = served();
    s.ctx.serveStatic = () => false;
    const agent = as("oauth:g1", ["artifacts", "read"]);
    await s.tools.deploy(s.scope(as("t-ci", ["deploy"])), {
      files: PAGE,
      name: "boxed",
      visibility: "public",
    });
    const boxed = resolvePreview(s.ctx, "boxed");
    const change = { kind: "edit" as const, files: { "index.html": "v2" } };
    await expect(redeploy(s.ctx, { actor: agent, previewId: boxed.id, change })).rejects.toThrow(
      "rebuilding this preview needs a container",
    );

    s.ctx.serveStatic = () => true;
    await s.tools.deploy(s.scope(agent), { files: PAGE, name: "page", visibility: "public" });
    const page = resolvePreview(s.ctx, "page");
    await expect(
      redeploy(s.ctx, {
        actor: agent,
        previewId: page.id,
        change: { kind: "edit", files: APP },
        runtime: "node",
      }),
    ).rejects.toThrow("needs a container");
    expect(resolvePreview(s.ctx, "page").state).toBe("awake");
  });

  test("reaches only what this credential deployed, not all its person did", async () => {
    const s = served();
    const agent = as("oauth:g1", ["artifacts"]);
    const adaCi = as("t-ci", ["deploy"]);
    await s.tools.deploy(s.scope(adaCi), { files: PAGE, name: "ada-own", visibility: "public" });
    await s.tools.deploy(s.scope(agent), { files: PAGE, name: "mine", visibility: "public" });

    const listed = await s.tools.status(s.scope(agent), undefined);
    expect(listed).toStartWith("1 preview:\nmine: awake");
    await expect(s.tools.status(s.scope(agent), "ada-own")).rejects.toThrow("no live preview");
    await expect(
      s.tools.status(s.scope(agent), "https://ada-own.preview.localhost:8443/"),
    ).rejects.toThrow("no preview answers");
    await expect(s.tools.logs(s.scope(agent), "ada-own", 5)).rejects.toThrow("no live preview");
    await expect(
      s.tools.deploy(s.scope(agent), { preview: "ada-own", files: PAGE }),
    ).rejects.toThrow("no live preview");
    await expect(s.tools.destroy(s.scope(agent), "ada-own")).rejects.toThrow("no live preview");

    expect(await s.tools.logs(s.scope(agent), "mine", 5)).toContain("mine: awake");
    expect(
      await s.tools.deploy(s.scope(agent), { preview: "mine", files: { "index.html": "v2" } }),
    ).toContain("(rebuilt)");
    expect(await s.tools.destroy(s.scope(agent), "mine")).toBe("destroyed mine");

    // Ada's own deploy credential still reaches everything Ada deployed, the agent's too.
    expect(await s.tools.status(s.scope(adaCi), undefined)).toStartWith("1 preview:\nada-own");
  });

  test("a second connection of the same person does not share the first one's previews", async () => {
    const s = served();
    await s.tools.deploy(s.scope(as("oauth:g1", ["artifacts"])), {
      files: PAGE,
      name: "first",
      visibility: "public",
    });
    expect(await s.tools.status(s.scope(as("oauth:g2", ["artifacts"])), undefined)).toBe(
      "no previews",
    );
  });

  test("with read as well it sees everything, and still deploys no container", async () => {
    const s = served();
    await s.tools.deploy(s.scope(as("t-ci", ["deploy"])), {
      files: PAGE,
      name: "ada-own",
      visibility: "public",
    });
    const agent = as("oauth:g1", ["read", "artifacts"]);
    expect(await s.tools.status(s.scope(agent), "ada-own")).toStartWith("ada-own: awake");
    await expect(s.tools.deploy(s.scope(agent), { image: "nginx", port: 80 })).rejects.toThrow(
      "needs a container",
    );
  });
});

describe("the REST API", () => {
  test("an artifacts credential lists, reads and destroys only its own", async () => {
    const s = served();
    const agent = as("t-agent", ["artifacts"]);
    await s.tools.deploy(s.scope(as("t-ci", ["deploy"])), {
      files: PAGE,
      name: "ada-own",
      visibility: "public",
    });
    await s.tools.deploy(s.scope(agent), { files: PAGE, name: "mine", visibility: "public" });
    const other = resolvePreview(s.ctx, "ada-own").id;
    const mine = resolvePreview(s.ctx, "mine").id;
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(silentLogger()));
    app.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", agent);
      return next();
    });
    previewRoutes(app, s.ctx, s.deploys);

    const list = (await (await app.request("/previews")).json()) as { previews: { id: string }[] };
    expect(list.previews.map((p) => p.id)).toEqual([mine]);
    expect((await app.request(`/previews/${other}`)).status).toBe(404);
    expect((await app.request(`/previews/${other}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.request(`/previews/${other}/logs`)).status).toBe(404);
    expect((await app.request(`/previews/${mine}`)).status).toBe(200);
    expect((await app.request(`/previews/${mine}`, { method: "DELETE" })).status).toBe(200);
    const image = await app.request("/previews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { kind: "image", image: "nginx", port: 80 } }),
    });
    expect(image.status).toBe(403);
  });
});

describe("the deploy scope", () => {
  test("destroys its person's previews but not someone else's", async () => {
    const s = served();
    const ada = as("t-ada", ["deploy"], "ada");
    const bob = as("t-bob", ["deploy"], "bob");
    await s.tools.deploy(s.scope(ada), { files: PAGE, name: "ada-site", visibility: "public" });
    await s.tools.deploy(s.scope(bob), { files: PAGE, name: "bob-site", visibility: "public" });
    await expect(s.tools.destroy(s.scope(bob), "ada-site")).rejects.toThrow(
      '"previews.destroy_own" covers only your own',
    );
    expect(await s.tools.destroy(s.scope(bob), "bob-site")).toBe("destroyed bob-site");
    expect(resolvePreview(s.ctx, "ada-site").state).toBe("awake");
  });
});

describe("consent", () => {
  test("offers artifacts wherever deploy is asked for", () => {
    expect(offeredScopes(["read", "deploy"])).toEqual(["read", "deploy", "artifacts"]);
    expect(offeredScopes(["read"])).toEqual(["read"]);
    expect(offeredScopes(["artifacts"])).toEqual(["artifacts"]);
  });
});
