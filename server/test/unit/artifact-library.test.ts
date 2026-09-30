import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  cleanSvg,
  compileTheme,
  ThemeCreateSchema,
  type Theme,
} from "@gangway/shared/artifact/theme";
import { setFrontMatter } from "@gangway/shared/artifact/grammar";
import { ArtifactLibrary } from "../../src/artifacts/library.ts";
import type { Actor } from "../../src/auth/actor.ts";
import { artifactRoutes } from "../../src/app/routes/artifacts.ts";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { ArtifactTemplatesRepo, ArtifactThemesRepo } from "../../src/db/repos/artifacts.ts";
import { IdempotentDeploys } from "../../src/previews/idempotent.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { silentLogger } from "../helpers/logger.ts";
import { ACTOR } from "../helpers/preview-context.ts";
import { deployFiles, setupServed } from "../helpers/runtimes-fixtures.ts";

const TOKENS = { light: { ink: "#112233", flag: "oklch(0.7 0.2 30)" }, dark: { paper: "#000" } };

function theme(over: Partial<Theme> = {}): Theme {
  return {
    id: "acme",
    name: "Acme",
    description: "",
    builtin: false,
    tokens: TOKENS,
    fonts: { sans: "inter", titles: "sans" },
    style: {},
    logo: null,
    ...over,
  };
}

describe("themes", () => {
  test("compile to token declarations for light and dark, fonts and a title style", () => {
    const css = compileTheme(theme({ logo: "<svg></svg>" }), "/_gangway/theme-logo.svg");
    expect(css).toContain(":root{--ink:#112233;--flag:oklch(0.7 0.2 30);--font-sans:");
    expect(css).toContain("--font-title:var(--font-sans);--title-style:normal;--title-weight:600;");
    expect(css).toContain('--logo:url("/_gangway/theme-logo.svg");');
    expect(css).toContain(':root[data-theme="dark"]{--paper:#000;}');
  });

  test("compile a style and the new fonts to fixed values, nothing for one left out", () => {
    const css = compileTheme(
      theme({
        fonts: { serif: "lora", display: "caveat", titles: "display", titleWeight: "bold" },
        style: { corners: "round", grid: "none", density: "compact" },
      }),
    );
    expect(css).toContain("--font-serif:Lora, Georgia, serif;");
    expect(css).toContain("--font-display:Caveat,");
    expect(css).toContain(
      "--font-title:var(--font-display);--title-style:normal;--title-weight:700;",
    );
    expect(css).toContain("--radius:14px;--radius-sm:8px;");
    expect(css).toContain("--canvas-grid:none;");
    expect(css).toContain("--space:0.8;");
    expect(css).not.toContain("--card-edge");
    expect(compileTheme(theme({ style: {} }))).not.toContain("--radius");
    expect(
      ThemeCreateSchema.safeParse({ id: "x", name: "X", tokens: TOKENS, style: { grid: "hex" } })
        .success,
    ).toBe(false);
    expect(
      ThemeCreateSchema.safeParse({ id: "x", name: "X", tokens: TOKENS, style: { radius: 4 } })
        .success,
    ).toBe(false);
  });

  test("take colours only: anything that could end a declaration is refused", () => {
    const create = (ink: string) =>
      ThemeCreateSchema.safeParse({ id: "x", name: "X", tokens: { light: { ink }, dark: {} } });
    expect(create("#fff").success).toBe(true);
    expect(create("rgb(1 2 3 / 50%)").success).toBe(true);
    expect(create("red;}body{display:none").success).toBe(false);
    expect(create("url(https://evil.example)").success).toBe(false);
    expect(ThemeCreateSchema.safeParse({ id: "chart", name: "C", tokens: TOKENS }).success).toBe(
      false,
    );
  });

  test("a logo keeps its drawing and loses scripts, handlers and outside links", () => {
    const svg = cleanSvg(
      '<svg onload="x()"><script>alert(1)</script><a href="https://evil"><rect/></a><use href="#r"/><foreignObject><p>hi</p></foreignObject></svg>',
    )!;
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("onload");
    expect(svg).not.toContain("https://evil");
    expect(svg).not.toContain("foreignObject");
    expect(svg).toContain('<use href="#r"/>');
    expect(cleanSvg("<p>not svg</p>")).toBeNull();
  });

  test("a logo can't rebuild a script or handler from the pieces left by a removal", () => {
    const svg = cleanSvg(
      "<svg><g/onload=x()/><scr<script></script>ipt>alert(1)</script><a href=https://evil><use href=#r/></a></svg>",
    )!;
    expect(svg).not.toMatch(/<script|onload|evil/i);
    expect(svg).toContain("<use href=#r/>");
  });
});

describe("front matter", () => {
  test("setFrontMatter changes keys in place, adds new ones and removes nulls", () => {
    const md = "---\nkind: document\ntitle: Old\naccent: red\n---\n# Body\n";
    expect(setFrontMatter(md, { title: "New", accent: null, mode: "dark", theme: undefined })).toBe(
      "---\nkind: document\ntitle: New\nmode: dark\n---\n# Body\n",
    );
  });
});

function setup(actor: Actor = ACTOR) {
  const s = setupServed();
  const themes = new ArtifactThemesRepo(s.db);
  const templates = new ArtifactTemplatesRepo(s.db);
  const settings = new Settings({}, new MemorySettingsStore());
  const library = new ArtifactLibrary({
    themes,
    templates,
    defaultTheme: () => settings.get(SETTINGS.artifactTheme),
  });
  s.ctx.artifacts = library;
  const api = new Hono<AppEnv>();
  api.onError(errorHandler(silentLogger()));
  api.use(async (c, next) => {
    c.set("requestId", "r");
    c.set("actor", actor);
    return next();
  });
  artifactRoutes(api, {
    library,
    themes,
    templates,
    settings,
    audit: s.ctx.audit,
    deploys: new IdempotentDeploys(s.ctx, undefined as never),
    wire: (p) => p,
    ctx: s.ctx,
  });
  const call = (method: string, path: string, body?: unknown) =>
    api.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...s, library, settings, call };
}

const DOC = "---\nkind: document\ntitle: {{title}}\n---\n## Status\n{{subtitle}}\n";

describe("the artifacts API", () => {
  test("lists gangway's theme first, and makes, restyles and deletes one of your own", async () => {
    const t = setup();
    const made = await t.call("POST", "/artifact-themes", {
      id: "acme",
      name: "Acme",
      tokens: TOKENS,
      logo: '<svg onload="x()"><rect/></svg>',
    });
    expect(made.status).toBe(201);
    const { themes } = (await (await t.call("GET", "/artifact-themes")).json()) as {
      themes: { id: string; isDefault: boolean; logo: string | null }[];
    };
    expect(themes.map((x) => [x.id, x.isDefault])).toEqual([
      ["chart", true],
      ["acme", false],
    ]);
    expect(themes[1]!.logo).toBe("<svg><rect/></svg>");
    expect((await t.call("PUT", "/artifact-themes/default", { id: "acme" })).status).toBe(200);
    expect(t.library.defaultThemeId()).toBe("acme");
    expect((await t.call("DELETE", "/artifact-themes/acme")).status).toBe(409);
    expect((await t.call("PUT", "/artifact-themes/chart", { name: "Mine" })).status).toBe(409);
  });

  test("a template of your own is checked, listed after the built-ins and filled in", async () => {
    const t = setup();
    const bad = await t.call("POST", "/artifact-templates", {
      id: "deck/weekly",
      name: "Weekly",
      files: { "artifact.md": DOC },
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { detail: string }).detail).toContain("the id says deck");
    const ok = await t.call("POST", "/artifact-templates", {
      id: "document/weekly",
      name: "Weekly update",
      files: { "artifact.md": DOC },
    });
    expect(ok.status).toBe(201);
    expect(
      (await t.call("POST", "/artifact-templates", { id: "document/memo", name: "x", files: {} }))
        .status,
    ).toBe(409);
    const list = (await (await t.call("GET", "/artifact-templates?kind=document")).json()) as {
      templates: { id: string; builtin: boolean }[];
    };
    expect(list.templates.at(-1)).toMatchObject({ id: "document/weekly", builtin: false });
    const { files } = (await (
      await t.call("POST", "/artifact-templates/render", {
        template: "document/weekly",
        title: "Week 40",
        subtitle: "All green",
        mode: "dark",
      })
    ).json()) as { files: Record<string, string> };
    expect(files["artifact.md"]).toBe(
      "---\nkind: document\ntitle: Week 40\nsubtitle: All green\nmode: dark\n---\n## Status\nAll green\n",
    );
  });

  test("POST /artifacts deploys a template to a preview", async () => {
    const t = setup();
    const res = await t.call("POST", "/artifacts", {
      template: "canvas/architecture",
      title: "Our system",
      name: "system",
      visibility: "public",
    });
    expect(res.status).toBe(202);
    const { preview } = (await res.json()) as { preview: { id: string; title: string } };
    expect(preview.title).toBe("Our system");
    await t.ctx.inflight.get(preview.id)?.done;
    expect(t.previews.get(preview.id)!.state).toBe("awake");
    expect(t.previews.get(preview.id)!.project).toEndWith("-system");
    const { artifacts } = (await (await t.call("GET", "/artifacts")).json()) as {
      artifacts: { preview: { id: string }; kind: string }[];
    };
    expect(artifacts.map((a) => [a.preview.id, a.kind])).toEqual([[preview.id, "canvas"]]);
  });

  test("only artifacts.manage may make themes and templates", async () => {
    const reader: Actor = {
      kind: "user",
      userId: "u",
      roleId: "viewer",
      permissions: new Set(["previews.read"]),
      sessionId: "s",
    };
    const t = setup(reader);
    expect((await t.call("GET", "/artifact-themes")).status).toBe(200);
    expect(
      (await t.call("POST", "/artifact-themes", { id: "a", name: "A", tokens: TOKENS })).status,
    ).toBe(403);
  });
});

describe("deploying with a theme", () => {
  test("a theme this server lacks is refused, and the site serves the one it names", async () => {
    const t = setup();
    const md = (theme: string) => `---\nkind: document\ntitle: T\ntheme: ${theme}\n---\nhi\n`;
    await expect(deployFiles(t, { "artifact.md": md("nope") })).rejects.toThrow(
      'theme: no theme called "nope"',
    );
    await t.call("POST", "/artifact-themes", { id: "acme", name: "Acme", tokens: TOKENS });
    const res = await deployFiles(t, { "artifact.md": md("acme") });
    expect((await res.done).state).toBe("awake");
    expect((await t.sites.open(res.preview.id))!.theme).toBe("acme");
    expect(t.library.themeCss("acme", "/logo")).toContain("--ink:#112233");
    expect(t.library.themeCss(null, "/logo")).toContain("gangway's own theme");
  });

  test("css: is refused when the server keeps artifacts in their theme", async () => {
    const t = setup();
    t.ctx.artifactCss = () => false;
    const md = "---\nkind: document\ntitle: T\ncss: style.css\n---\nhi\n";
    await expect(deployFiles(t, { "artifact.md": md, "style.css": "body{}" })).rejects.toThrow(
      "keeps every artifact in its theme",
    );
  });
});

describe("the UI's preview frame", () => {
  test("is framable only by the UI, sandboxed, and loads a kit anyone may read", async () => {
    const { serveKitFrame, FRAME_PATH } = await import("../../src/app/kit-frame.ts");
    const frame = (await serveKitFrame(new Request(`https://app.example${FRAME_PATH}`)))!;
    expect(frame.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; frame-ancestors 'self'",
    );
    const { version } = (await import("../../src/previews/artifact-render.ts")).renderAssets();
    expect(await frame.text()).toContain(`import("/_gangway/kit.js?v=${version}")`);
    const kit = (await serveKitFrame(new Request("https://app.example/_gangway/kit.js")))!;
    expect(kit.headers.get("access-control-allow-origin")).toBe("*");
    expect(kit.headers.get("cache-control")).toBe("no-cache");
    const versioned = (await serveKitFrame(
      new Request(`https://app.example/_gangway/kit.js?v=${version}`, {
        headers: { "accept-encoding": "br, gzip" },
      }),
    ))!;
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const again = (await serveKitFrame(
      new Request(`https://app.example/_gangway/kit.js?v=${version}`, {
        headers: { "if-none-match": versioned.headers.get("etag")! },
      }),
    ))!;
    expect(again.status).toBe(304);
    expect(await serveKitFrame(new Request("https://app.example/_gangway/../secrets"))).toBeNull();
  });
});
