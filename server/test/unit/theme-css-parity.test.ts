import { describe, expect, test } from "bun:test";
import { THEME_FONTS, THEME_STYLE, compileTheme, type Theme } from "@gangway/shared/artifact/theme";
import { themeCss } from "../../../web/src/app/features/artifacts/theme-css.ts";

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
    for (const [slot, fonts] of Object.entries(THEME_FONTS))
      for (const key of Object.keys(fonts)) same({ ...base, fonts: { [slot]: key } });
  });

  test("matches the server's for every style choice and title option", () => {
    for (const [k, choices] of Object.entries(THEME_STYLE))
      for (const v of choices) same({ ...base, style: { [k]: v } });
    for (const titles of ["italic-serif", "serif", "sans", "display"] as const)
      for (const titleWeight of ["light", "regular", "semibold", "bold"] as const)
        for (const titleCase of ["normal", "upper"] as const)
          same({ ...base, fonts: { titles, titleWeight, titleCase } });
  });
});
