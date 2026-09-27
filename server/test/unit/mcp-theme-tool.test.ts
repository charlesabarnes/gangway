import { describe, expect, test } from "bun:test";
import { SCOPE_PERMISSIONS } from "@gangway/shared/permissions";
import { ArtifactLibrary } from "../../src/artifacts/library.ts";
import { tokenActor } from "../../src/auth/actor.ts";
import { ArtifactThemesRepo } from "../../src/db/repos/artifacts.ts";
import { Tools } from "../../src/mcp/tools.ts";
import { ThemeArgs } from "../../src/mcp/setup-tool-specs.ts";
import { MissingPermission } from "../../src/mcp/tool-access.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { setupTools } from "../helpers/mcp-tools.ts";
import { silentLogger } from "../helpers/logger.ts";

const DESIGNER = tokenActor("t-themes", ["read", "deploy", "themes"]);
const TOKENS = {
  light: { paper: "#ffffff", ink: "#111827", primary: "#e11d48" },
  dark: { paper: "#0b0b0f", ink: "#f3f4f6", primary: "#fb7185" },
};

function setup() {
  const s = setupTools();
  const themes = new ArtifactThemesRepo(s.db);
  const settings = new Settings({}, new MemorySettingsStore());
  s.ctx.artifacts = new ArtifactLibrary({
    themes,
    defaultTheme: () => settings.get(SETTINGS.artifactTheme),
  });
  const tools = new Tools({
    ctx: s.ctx,
    deploys: s.deploys,
    logger: silentLogger(),
    themes: { themes, settings },
  });
  return { ...s, tools, themes, settings };
}

describe("the theme tool", () => {
  test("the themes scope is making themes, and no more", () => {
    expect(SCOPE_PERMISSIONS.themes).toEqual(["artifacts.manage"]);
  });

  test("creates a theme and says how to use it, with gangway's values for the rest", () => {
    const s = setup();
    const out = s.tools.theme(s.scope(DESIGNER), {
      id: "acme",
      name: "Acme",
      tokens: TOKENS,
      fonts: { sans: "inter", titles: "sans" },
    });
    expect(out).toStartWith('theme acme ("Acme") created.');
    expect(out).toContain('artifact: {template, theme: "acme"}');
    expect(out).toContain('"primary": "#e11d48"');
    expect(out).toContain("gangway's own values");
    expect(s.themes.get("acme")!.fonts).toEqual({ sans: "inter", titles: "sans" });
    expect(s.audit.page({ limit: 5, action: "artifact_theme.created" }).entries).toHaveLength(1);
  });

  test("an existing id is changed, only in what was sent; just an id reads it", () => {
    const s = setup();
    s.tools.theme(s.scope(DESIGNER), { id: "acme", name: "Acme", tokens: TOKENS });
    const out = s.tools.theme(s.scope(DESIGNER), { id: "acme", description: "From acme.com" });
    expect(out).toStartWith('theme acme ("Acme") updated.');
    expect(s.themes.get("acme")!.tokens).toEqual(TOKENS);
    expect(s.tools.theme(s.scope(DESIGNER), { id: "acme" })).toStartWith(
      'theme acme ("Acme") unchanged.',
    );
  });

  test("keeps a style and lists the choices; an unknown choice is refused", () => {
    const s = setup();
    const out = s.tools.theme(s.scope(DESIGNER), {
      id: "acme",
      name: "Acme",
      tokens: TOKENS,
      fonts: {
        sans: "manrope",
        display: "playfair-display",
        titles: "display",
        titleCase: "upper",
      },
      style: { corners: "round", edges: "shadow", grid: "none" },
    });
    expect(out).toContain('"grid": "none"');
    expect(out).toContain("grid: lines, dots, none");
    expect(out).toContain("display: playfair-display");
    expect(s.themes.get("acme")!.style).toEqual({
      corners: "round",
      edges: "shadow",
      grid: "none",
    });
    s.tools.theme(s.scope(DESIGNER), { id: "acme", style: { density: "airy" } });
    expect(s.themes.get("acme")!.style).toEqual({ density: "airy" });
    expect(s.themes.get("acme")!.fonts.sans).toBe("manrope");
    expect(ThemeArgs.safeParse({ id: "acme", style: { corners: "blobby" } }).success).toBe(false);
    expect(ThemeArgs.safeParse({ id: "acme", style: '{"grid":"dots"}' }).success).toBe(true);
  });

  test("makeDefault makes it the server's default", () => {
    const s = setup();
    const out = s.tools.theme(s.scope(DESIGNER), {
      id: "acme",
      name: "Acme",
      tokens: TOKENS,
      makeDefault: true,
    });
    expect(out).toContain("it is the server's default");
    expect(s.settings.get(SETTINGS.artifactTheme)).toBe("acme");
  });

  test("refuses a new theme with no name, and changing gangway's own", () => {
    const s = setup();
    expect(() => s.tools.theme(s.scope(DESIGNER), { id: "acme" })).toThrow("needs a name");
    expect(() =>
      s.tools.theme(s.scope(DESIGNER), { id: "chart", description: "mine now" }),
    ).toThrow("cannot be changed");
  });

  test("a connection without the themes scope is refused, and told which to grant", () => {
    const s = setup();
    const deployOnly = tokenActor("t-deploy", ["read", "deploy"]);
    expect(() =>
      s.tools.theme(s.scope(deployOnly), { id: "acme", name: "Acme", tokens: TOKENS }),
    ).toThrow(MissingPermission);
    expect(() => s.tools.theme(s.scope(deployOnly), { id: "acme", name: "Acme" })).toThrow(
      "grant the themes scope",
    );
    expect(s.themes.get("acme")).toBeUndefined();
    expect(s.tools.missingFor(deployOnly, "theme", { id: "acme" })).toBe("artifacts.manage");
  });
});
