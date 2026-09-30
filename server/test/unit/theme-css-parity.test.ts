import { describe, expect, test } from "bun:test";
import {
  HOUSE_TOKENS,
  THEME_FONTS,
  THEME_STYLE,
  ThemeCreateSchema,
  compileTheme,
  type Theme,
} from "@gangway/shared/artifact/theme";
import { themeCss } from "../../../web/src/app/features/artifacts/theme-css.ts";
import { readability } from "../../../web/src/app/features/artifacts/readability.ts";
import { randomTheme } from "../../../web/src/app/features/artifacts/theme-random.ts";

// The theme editor compiles a theme in the browser to preview it before it is saved; it must
// write what the server will.

const base: Theme = {
  id: "acme",
  name: "Acme",
  description: "",
  builtin: false,
  tokens: { light: { ink: "#112233" }, dark: { paper: "#000" } },
  fonts: {},
  style: {},
  logo: null,
};

const rules = (css: string) => css.split("\n").filter((l) => l.startsWith(":root"));
// The editor's types name every font key a string; the server's narrow them to its list.
const same = (t: Theme) =>
  expect(rules(themeCss(t as Parameters<typeof themeCss>[0])).join("")).toBe(
    rules(compileTheme(t)).join(""),
  );

describe("the editor's theme stylesheet", () => {
  test("matches the server's for every font", () => {
    for (const [slot, fonts] of Object.entries(THEME_FONTS)) {
      for (const key of Object.keys(fonts)) {
        same({ ...base, fonts: { [slot]: key } });
      }
    }
  });

  test("matches the server's for every style choice and title option", () => {
    for (const [k, choices] of Object.entries(THEME_STYLE)) {
      for (const v of choices) {
        same({ ...base, style: { [k]: v } });
      }
    }
    for (const titles of ["italic-serif", "serif", "sans", "display"] as const) {
      for (const titleWeight of ["light", "regular", "semibold", "bold"] as const) {
        for (const titleCase of ["normal", "upper"] as const) {
          same({ ...base, fonts: { titles, titleWeight, titleCase } });
        }
      }
    }
  });
});

describe("the editor's random themes", () => {
  test("gangway's own colours pass every readability check", () => {
    expect(readability({ light: {}, dark: {} }, HOUSE_TOKENS)).toEqual([]);
  });

  // A seeded generator, so a failure names a seed that reproduces it.
  const seeded = (seed: number) => () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };

  test("are readable themes the server takes, and nearly never the same twice", () => {
    const seen = new Set<string>();
    const draws = 300;
    for (let seed = 1; seed <= draws; seed++) {
      const t = randomTheme(seeded(seed));
      seen.add(JSON.stringify([t.fonts, t.style]));
      const { word: _, ...fields } = t;
      const parsed = ThemeCreateSchema.safeParse({ id: "random", ...fields });
      expect({ seed, issues: parsed.error?.issues ?? [] }).toEqual({ seed, issues: [] });
      expect({ seed, unreadable: readability(t.tokens, HOUSE_TOKENS) }).toEqual({
        seed,
        unreadable: [],
      });
    }
    // Type and shape alone, before the colours: all but a handful of draws are new.
    expect(seen.size).toBeGreaterThan(draws * 0.97);
  });
});
