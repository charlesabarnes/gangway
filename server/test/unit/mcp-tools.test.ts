import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tokenActor, type Actor } from "../../src/auth/actor.ts";
import type { AppError } from "../../src/errors.ts";
import { refusalDetail } from "../../src/mcp/describe.ts";
import { resolvePreview } from "../../src/mcp/resolve.ts";
import { TOOL_PERMISSIONS } from "../../src/mcp/tool-access.ts";
import { DeployArgs } from "../../src/mcp/tool-specs.ts";
import { READ_ONLY, setupTools } from "../helpers/mcp-tools.ts";
import { ACTOR } from "../helpers/preview-context.ts";

const sha12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

describe("the tools", () => {
  test("each of the five tools names its permissions", () => {
    expect(TOOL_PERMISSIONS).toEqual({
      deploy: ["previews.deploy", "previews.deploy_static"],
      status: ["previews.read", "previews.read_own"],
      logs: ["logs.read", "previews.read_own"],
      destroy: ["previews.destroy", "previews.destroy_own"],
      catalog: ["previews.read", "previews.read_own"],
    });
  });

  test("catalog gives the guide, the templates and one template's files", () => {
    const s = setupTools();
    const out = s.tools.catalog(s.scope(), "deck");
    expect(out).toContain("- deck/pitch:");
    expect(out).toContain("- deck/status:");
    expect(out).toContain("## Decks");
    expect(out).not.toContain("## Prototypes");
    expect(out).toContain("--- artifact.md\n---\nkind: deck");
    expect(s.tools.catalog(s.scope(), "deck", "deck/lesson")).toContain(
      "The deck/lesson template's files",
    );
    expect(() => s.tools.catalog(s.scope(), "deck", "dashboard/kpi")).toThrow(
      'no deck template "dashboard/kpi"',
    );
  });

  test("preview + artifact rebuilds from a template at the same URL", async () => {
    const s = setupTools();
    const first = await s.tools.deploy(s.scope(), {
      artifact: { template: "deck/pitch" },
      name: "same",
      visibility: "public",
    });
    const again = await s.tools.deploy(s.scope(), {
      preview: "same",
      artifact: { template: "deck/pitch", title: "Renamed" },
    });
    expect(again).toStartWith(first.split("\n")[0]!.replace("ready: ", "ready: ").trim());
    expect(again).toContain("(rebuilt)");
  });

  test("artifact may arrive as JSON text", () => {
    expect(DeployArgs.parse({ artifact: '{"template":"deck/lesson"}' }).artifact).toEqual({
      template: "deck/lesson",
    });
  });

  test("deploy artifact builds a template with its settings", async () => {
    const s = setupTools();
    const out = await s.tools.deploy(s.scope(), {
      artifact: {
        template: "deck/status",
        title: "Weekly",
        accent: "red",
        options: { streams: 2 },
      },
      name: "weekly",
      visibility: "public",
    });
    expect(out).toStartWith("ready: https://weekly.preview.localhost:8443/");
    expect(out).toContain("artifact.md (a deck)");
    await expect(
      s.tools.deploy(s.scope(), {
        artifact: { template: "deck/status", options: { chart: "pie" } },
      }),
    ).rejects.toThrow("artifact: options.chart: one of line, bar, none");
  });

  test("deploy from files returns the URL once it answers; the rest find it by name", async () => {
    const s = setupTools();
    const out = await s.tools.deploy(s.scope(), {
      files: { "index.html": "<h1>hi</h1>" },
      name: "hello",
      visibility: "public",
    });
    expect(out).toStartWith("ready: https://hello.preview.localhost:8443/");
    expect(out).toContain("hello: awake");
    const p = resolvePreview(s.ctx, "hello");
    expect(p.source).toMatchObject({ kind: "tarball", runtime: "static" });

    expect(await s.tools.status(s.scope(), "hello")).toStartWith(
      "hello: awake — https://hello.preview.localhost:8443/",
    );
    expect(
      await s.tools.status(s.scope(), "https://hello.preview.localhost:8443/some/page"),
    ).toStartWith("hello: awake");
    expect(await s.tools.status(s.scope(), p.id)).toStartWith("hello: awake");
    expect(await s.tools.status(s.scope(), undefined)).toStartWith("1 preview:\nhello: awake");
    expect(await s.tools.logs(s.scope(), "hello", 5)).toContain("hello: awake");

    expect(await s.tools.destroy(s.scope(), "hello")).toBe("destroyed hello");
    expect(await s.tools.status(s.scope(), undefined)).toBe("no previews");
  });

  test("an identical retry is the same preview; other contents under the name conflict", async () => {
    const s = setupTools();
    const args = { files: { "index.html": "a" }, name: "retry", visibility: "public" as const };
    const first = await s.tools.deploy(s.scope(), args);
    const again = await s.tools.deploy(s.scope(), args);
    expect(first).toStartWith("ready:");
    expect(again).toContain("the same preview an earlier identical call made");
    expect(s.ctx.previews.list({}).length).toBe(1);
    await expect(
      s.tools.deploy(s.scope(), { ...args, files: { "index.html": "b" } }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("an explicit key reused with a different request is refused", async () => {
    const s = setupTools();
    const deploy = (name: string) =>
      s.tools.deploy(s.scope(), {
        files: { "index.html": "a" },
        name,
        visibility: "public",
        idempotencyKey: "same",
      });
    await deploy("k1");
    await expect(deploy("k2")).rejects.toMatchObject({ code: "unprocessable" });
  });

  test("an image deploy with waitSeconds 0 returns at once with the URL and next step", async () => {
    const s = setupTools();
    const out = await s.tools.deploy(s.scope(), {
      image: "traefik/whoami:v1.10",
      port: 80,
      name: "who",
      visibility: "public",
      waitSeconds: 0,
    });
    expect(out).toMatch(
      /^still (building|starting|awake) after 0s: https:\/\/who\.preview\.localhost:8443\//,
    );
    expect(out).toContain('Call status with preview "who"');
    await s.ctx.inflight.get(resolvePreview(s.ctx, "who").id)?.done;
  });

  test("a failed deploy says why and shows the end of the log", async () => {
    const s = setupTools();
    s.fake.buildExit = 1;
    const out = await s.tools.deploy(s.scope(), {
      files: { "index.html": "x" },
      name: "broken",
      visibility: "public",
    });
    expect(out).toStartWith("failed:");
    expect(out).toContain("last log lines:");
    expect(out).toContain("load build definition from Dockerfile");
  });

  test.each([
    ["no source", {}, "exactly one of artifact, files, upload, image or git"],
    ["an image without a port", { image: "nginx" }, "needs port"],
    [
      "addons with an image",
      { image: "nginx", port: 80, addons: ["postgres"] },
      "addons go with files",
    ],
    ["an unknown addon", { files: { a: "" }, addons: ["mongo"] }, undefined],
    [
      "remove without a preview",
      { files: { a: "" }, remove: ["b"] },
      "remove only goes with preview",
    ],
  ])("refuses %s before anything starts", async (_what, args, why) => {
    const s = setupTools();
    await expect(s.tools.deploy(s.scope(), args as never)).rejects.toThrow(why);
    expect(s.ctx.previews.list({}).length).toBe(0);
  });

  test("preview + files rebuilds at the same URL and needs previews.update", async () => {
    const s = setupTools();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "v1" },
      name: "site",
      visibility: "public",
    });
    const id = resolvePreview(s.ctx, "site").id;
    const out = await s.tools.deploy(s.scope(), {
      preview: "site",
      files: { "about.html": "about" },
    });
    expect(out).toStartWith("ready: https://site.preview.localhost:8443/ (rebuilt)");
    expect(resolvePreview(s.ctx, "site").id).toBe(id);
    expect((await s.ctx.sources!.list(id)).files.map((f) => f.path).sort()).toEqual([
      "about.html",
      "index.html",
    ]);

    const deployOnly = tokenActor("t-deploy", ["deploy"]);
    await expect(
      s.tools.deploy(s.scope(deployOnly), { preview: "site", files: { "x.html": "" } }),
    ).rejects.toThrow('lacks the "previews.update" permission');
  });

  test("the deploy scope rebuilds only what its person deployed, via any credential", async () => {
    const s = setupTools();
    const own = (tokenId: string, userId: string) =>
      ({ ...tokenActor(tokenId, ["deploy"]), userId }) as Actor;
    const adaCi = own("t-ci", "ada");
    const adaAgent = own("oauth:g1", "ada");
    const bob = own("t-bob", "bob");
    await s.tools.deploy(s.scope(adaCi), {
      files: { "index.html": "v1" },
      name: "ada-site",
      visibility: "public",
    });
    expect(s.ctx.previews.ownerOf(resolvePreview(s.ctx, "ada-site").id)).toBe("user:ada");
    expect(
      await s.tools.deploy(s.scope(adaAgent), {
        preview: "ada-site",
        files: { "index.html": "v2" },
      }),
    ).toContain("(rebuilt)");
    await expect(
      s.tools.deploy(s.scope(bob), { preview: "ada-site", files: { "index.html": "v3" } }),
    ).rejects.toThrow("was deployed by someone else");
    expect(s.tools.missingFor(bob, "deploy", { preview: "ada-site" })).toBe("previews.update");
    expect(s.tools.missingFor(adaAgent, "deploy", { preview: "ada-site" })).toBeNull();
    expect(s.tools.missingFor(READ_ONLY, "deploy", { files: {} })).toBe("previews.deploy");
    await expect(
      s.tools.deploy(s.scope(READ_ONLY), { preview: "ada-site", files: { a: "" } }),
    ).rejects.toThrow('"previews.deploy"');
  });

  test("a preview with no owner is rebuilt only with previews.update", async () => {
    const s = setupTools();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "v1" },
      name: "old",
      visibility: "public",
    });
    const id = resolvePreview(s.ctx, "old").id;
    // As a PR preview or a row from before 0010 would be.
    s.db.run("UPDATE previews SET owner = NULL WHERE id = $id", { id });
    const ada = { ...tokenActor("t-ada", ["deploy"]), userId: "ada" } as Actor;
    await expect(
      s.tools.deploy(s.scope(ada), { preview: "old", files: { "a.html": "" } }),
    ).rejects.toThrow("someone else");
    expect(await s.tools.deploy(s.scope(), { preview: "old", files: { "a.html": "" } })).toContain(
      "(rebuilt)",
    );
  });

  test("logs show the pipeline and the containers, scrubbed, or one part on request", async () => {
    const s = setupTools();
    s.ctx.addonSecret = () => "s3cret-derived-password";
    await s.tools.deploy(s.scope(), {
      files: { "index.ts": "Bun.serve({fetch(){return new Response('hi')}})" },
      name: "shop-api",
      visibility: "public",
      addons: ["postgres"],
    });
    s.fake.runtimeLog =
      "web-1       | listening on :3000\nweb-1       | DATABASE_URL=postgres://app:s3cret-derived-password@postgres:5432/app\n";
    const all = await s.tools.logs(s.scope(), "shop-api", 20);
    expect(all).toContain("pipeline (build, start, gangway):");
    expect(all).toContain("runtime (what the containers print):\nweb-1       | listening on :3000");
    expect(all).not.toContain("s3cret-derived-password");
    expect(all).toContain("[redacted]");

    const web = await s.tools.logs(s.scope(), "shop-api", 5, { service: "web" });
    expect(web).not.toContain("pipeline");
    expect(web).toContain("web only");
    expect(s.fake.all.at(-1)).toEqual(expect.arrayContaining(["logs", "--tail", "5", "web"]));
    expect(await s.tools.logs(s.scope(), "shop-api", 5, { source: "pipeline" })).not.toContain(
      "runtime (",
    );
    await expect(
      s.tools.logs(s.scope(), "shop-api", 5, { service: "web; rm -rf /" }),
    ).resolves.toContain("is not a service name");

    await s.tools.destroy(s.scope(), "shop-api");
  });

  test("ready explains the plan, hashes the deployed files, and GETs the checked paths", async () => {
    const s = setupTools();
    const asked: string[] = [];
    s.ctx.statusProbe = async (route, _host, path) => {
      asked.push(`${route.hostname}${path}`);
      return path === "/" ? 200 : 404;
    };
    const out = await s.tools.deploy(s.scope(), {
      files: { "index.html": "<h1>hi</h1>" },
      name: "rich",
      visibility: "public",
      check: ["/", "/nope"],
    });
    expect(out).toMatch(
      /plan: static [\d.]+ — the files are served by nginx\n {2}no marker file -> looks like Static site/,
    );
    expect(out).toContain(`${sha12("<h1>hi</h1>")}        11  index.html`);
    expect(out).toContain("checked: / 200 · /nope 404");
    expect(asked).toEqual(["rich.preview.localhost/", "rich.preview.localhost/nope"]);

    const again = await s.tools.deploy(s.scope(), {
      preview: "rich",
      files: { "index.html": "v2" },
      check: ["/"],
    });
    expect(again).toContain(`${sha12("v2")}         2  index.html`);
    expect(again).toContain("checked: / 200");
  });

  test("a plan that cannot run says why, reason by reason", async () => {
    const s = setupTools();
    const err = (await s.tools
      .deploy(s.scope(), { files: { "package.json": "{}" }, name: "noentry", visibility: "public" })
      .catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("unprocessable");
    const said = refusalDetail(err.detail);
    expect(said).toContain("package.json -> ");
    expect(said.split("\n").length).toBeGreaterThan(1);
  });

  test("an unlisted preview answers to its stem; an ambiguous stem lists both", async () => {
    const s = setupTools();
    const deployShop = (html: string) =>
      s.tools.deploy(s.scope(), {
        files: { "index.html": html },
        name: "shop",
        visibility: "unlisted",
      });
    await deployShop("a");
    expect(await s.tools.status(s.scope(), "shop")).toMatch(/^shop-[a-z0-9]{10}: awake/);
    await deployShop("b");
    await expect(s.tools.status(s.scope(), "shop")).rejects.toThrow("matches 2 previews");
    await expect(s.tools.status(s.scope(), "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(
      s.tools.status(s.scope(), "https://nope.preview.localhost/"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("a read-only credential may look but not touch", async () => {
    const s = setupTools();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "a" },
      name: "ro",
      visibility: "public",
    });
    expect(await s.tools.status(s.scope(READ_ONLY), "ro")).toStartWith("ro: awake");
    await expect(
      s.tools.deploy(s.scope(READ_ONLY), { files: { "index.html": "a" } }),
    ).rejects.toThrow('"previews.deploy"');
    await expect(s.tools.destroy(s.scope(READ_ONLY), "ro")).rejects.toThrow('"previews.destroy"');
  });

  test("an abort from switching MCP off ends the wait, not the deploy", async () => {
    const s = setupTools();
    s.fake.planDelayMs = 0;
    const abort = new AbortController();
    const pending = s.tools.deploy(s.scope(ACTOR, abort.signal), {
      image: "traefik/whoami:v1.10",
      port: 80,
      name: "cut",
      visibility: "public",
      waitSeconds: 60,
    });
    abort.abort();
    expect(await pending).toStartWith(
      "stopped waiting: the MCP surface was switched off. The deploy carries on: https://cut.preview.localhost:8443/",
    );
    const p = resolvePreview(s.ctx, "cut");
    expect((await s.ctx.inflight.get(p.id)?.done)?.state ?? s.ctx.previews.get(p.id)!.state).toBe(
      "awake",
    );
  });
});
