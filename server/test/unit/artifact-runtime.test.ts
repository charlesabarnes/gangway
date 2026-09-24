import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "@gangway/shared/artifact/index";
import { serveKitFont } from "../../src/app/kit-fonts.ts";
import { misdirectedPage, wakingPage } from "../../src/net/error-pages.ts";
import { passwordPage } from "../../src/net/gate-pages.ts";
import { artifactIndex, renderAssets } from "../../src/previews/artifact-render.ts";
import { writeRuntime } from "../../src/previews/runtimes.ts";
import { tempDir } from "../helpers/db.ts";
import {
  deployFiles,
  folder,
  planned,
  planRuntime,
  setupRuntimes,
} from "../helpers/runtimes-fixtures.ts";

const DECK = renderTemplate({ template: "deck/pitch", accent: "teal" });
const KIT_PAGE =
  '<!doctype html><link rel="stylesheet" href="/_gangway/kit.css"><gw-doc title="Mine"><p>hi</p></gw-doc>';

describe("an artifact.md upload", () => {
  test("builds nginx with the kit, its config and a generated index.html", async () => {
    const out = await planRuntime(await folder(DECK), "static");
    expect(out.dockerfile).toContain("COPY .gangway/render/ /usr/share/nginx/html/_gangway/");
    expect(out.dockerfile).toContain(
      "COPY .gangway/kit-config.json /usr/share/nginx/html/_gangway/config.json",
    );
    expect(out.dockerfile).toContain("COPY .gangway/index.html /usr/share/nginx/html/index.html");
    expect(out.files["kit-config.json"]).toBe('{"brand":true}\n');
    expect(out.files["index.html"]).toContain(
      "<title>A live preview for every pull request</title>",
    );
    expect(out.files["index.html"]).toContain('data-accent="teal"');
    expect(Object.keys(out.assets ?? {})).toContain("render/kit.js");
    expect(out.note).toContain("a deck rendered from artifact.md");
  });

  test("an index.html using the kit gets the kit but keeps its own page", async () => {
    const out = await planRuntime(await folder({ "index.html": KIT_PAGE }), "static");
    expect(out.dockerfile).toContain("/_gangway/");
    expect(out.dockerfile).not.toContain("COPY .gangway/index.html");
    expect(out.note).toContain("a document in gangway's elements");
  });

  test("the generated page escapes the title and description", () => {
    const html = artifactIndex(
      {
        kind: "document",
        title: "</title><script>x()</script>",
        description: 'a "b"',
        theme: "dark",
        accent: "flag",
        format: "markdown",
      },
      "v1",
    );
    expect(html).not.toContain("<script>x()");
    expect(html).toContain("&lt;/title&gt;");
    expect(html).toContain('content="a &quot;b&quot;"');
  });

  test("writeRuntime copies the kit into .gangway/ readable by nginx, with the mark off", async () => {
    const dir = await folder(DECK);
    await writeRuntime(
      dir,
      await planned(dir),
      {},
      join(tempDir(), "c.yaml"),
      undefined,
      undefined,
      false,
    );
    const js = join(dir, ".gangway/render/kit.js");
    expect(existsSync(js)).toBe(true);
    expect(statSync(js).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(dir, ".gangway/kit-config.json"), "utf8")).toBe('{"brand":false}\n');
  });

  test("deploys and says what it rendered", async () => {
    const s = setupRuntimes();
    const res = await deployFiles(s, renderTemplate({ template: "dashboard/kpi" }));
    expect((await res.done).state).toBe("awake");
    const log = s.ctx.logs.read(res.preview.id).map((l) => l.line);
    expect(log.join("\n")).toContain("a dashboard rendered from artifact.md");
  });

  test("a broken artifact.md is refused, naming the line, before anything is kept", async () => {
    const s = setupRuntimes();
    const bad = "---\nkind: deck\ntitle: T\n---\n# Hi\n\n---\n\n::: carousel\n:::\n";
    await expect(deployFiles(s, { "artifact.md": bad })).rejects.toMatchObject({
      code: "unprocessable",
      message: expect.stringContaining("artifact.md: line 9: unknown block :::carousel"),
    });
    expect(await s.sources.ids()).toEqual([]);
  });

  test("the kit manifest names a version", () => {
    expect(renderAssets().version).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("pages gangway serves for a preview", () => {
  test("the waking page wears the Chart look and the preview favicon", async () => {
    const html = await wakingPage("demo.preview.test").text();
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
    expect(html).toContain("gangway</div>");
    expect(html).toContain("IBM Plex Serif");
    expect(html).toContain("<h1>Waking this preview</h1>");
  });

  test("the waking page loads Plex from the app host", async () => {
    const html = await wakingPage("demo.preview.test").text();
    expect(html).toContain("src:url(//preview.test/_gangway/fonts/serif-400-italic.woff2)");
    expect(await misdirectedPage().text()).not.toContain("@font-face");
  });

  test("the password page's CSP allows fonts from the app host only", () => {
    const res = passwordPage("demo.preview.test", "/", null, 401);
    expect(res.headers.get("content-security-policy")).toContain("font-src preview.test;");
  });

  test("the app host serves the kit's fonts to any origin", async () => {
    const res = await serveKitFont(
      new Request("https://preview.test/_gangway/fonts/sans-400.woff2"),
    );
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    expect(res?.headers.get("content-type")).toBe("font/woff2");
    for (const bad of ["../manifest.json", "kit.js", "nope.woff2"])
      expect(
        await serveKitFont(new Request(`https://preview.test/_gangway/fonts/${bad}`)),
      ).toBeNull();
  });
});
