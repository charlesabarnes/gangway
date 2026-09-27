import { z } from "zod";
import { THEME_FONT_CHOICES, type ThemeFontSlot } from "./fonts.ts";
import { HOUSE_THEME, THEME_ID } from "./vocab.ts";

// A theme is the kit's tokens for light and dark, fonts, a title style, a shape and layout
// style and a logo, compiled to a stylesheet after the kit's own: no selectors, no free CSS.

export const THEME_TOKENS = [
  "paper",
  "paper-raised",
  "ink",
  "ink-muted",
  "rule",
  "primary",
  "on-primary",
  "flag",
  "on-flag",
  "awake",
  "warn",
  "danger",
  "header-bg",
  "header-fg",
  "header-muted",
  "header-rule",
  "log-bg",
  "log-fg",
  "s1",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

/** The house theme's values, which a new theme starts from and the editor shows. */
export const HOUSE_TOKENS: Record<"light" | "dark", Record<ThemeToken, string>> = {
  light: {
    paper: "oklch(0.97 0.012 85)",
    "paper-raised": "oklch(0.99 0.006 85)",
    ink: "oklch(0.27 0.06 255)",
    "ink-muted": "oklch(0.48 0.04 255)",
    rule: "oklch(0.84 0.025 240)",
    primary: "oklch(0.33 0.09 255)",
    "on-primary": "oklch(0.97 0.012 85)",
    flag: "oklch(0.84 0.15 88)",
    "on-flag": "oklch(0.25 0.05 255)",
    awake: "oklch(0.58 0.13 155)",
    warn: "oklch(0.55 0.13 70)",
    danger: "oklch(0.55 0.19 28)",
    "header-bg": "oklch(0.27 0.07 255)",
    "header-fg": "oklch(0.97 0.012 85)",
    "header-muted": "oklch(0.76 0.035 250)",
    "header-rule": "oklch(0.42 0.06 255)",
    "log-bg": "oklch(0.22 0.05 255)",
    "log-fg": "oklch(0.94 0.015 85)",
    s1: "oklch(0.33 0.09 255)",
    s2: "oklch(0.78 0.15 80)",
    s3: "oklch(0.55 0.19 28)",
    s4: "oklch(0.58 0.13 155)",
    s5: "oklch(0.62 0.09 220)",
    s6: "oklch(0.52 0.11 300)",
  },
  dark: {
    paper: "oklch(0.2 0.035 255)",
    "paper-raised": "oklch(0.25 0.04 255)",
    ink: "oklch(0.94 0.015 85)",
    "ink-muted": "oklch(0.72 0.03 250)",
    rule: "oklch(0.36 0.04 250)",
    primary: "oklch(0.84 0.15 88)",
    "on-primary": "oklch(0.22 0.05 255)",
    flag: "oklch(0.84 0.15 88)",
    "on-flag": "oklch(0.25 0.05 255)",
    awake: "oklch(0.75 0.14 155)",
    warn: "oklch(0.8 0.13 75)",
    danger: "oklch(0.62 0.18 28)",
    "header-bg": "oklch(0.15 0.03 255)",
    "header-fg": "oklch(0.94 0.015 85)",
    "header-muted": "oklch(0.72 0.03 250)",
    "header-rule": "oklch(0.32 0.04 255)",
    "log-bg": "oklch(0.14 0.03 255)",
    "log-fg": "oklch(0.94 0.015 85)",
    s1: "oklch(0.8 0.07 245)",
    s2: "oklch(0.84 0.15 88)",
    s3: "oklch(0.66 0.18 28)",
    s4: "oklch(0.75 0.14 155)",
    s5: "oklch(0.78 0.09 215)",
    s6: "oklch(0.72 0.11 300)",
  },
};

/** Font stacks by slot and key: the kit's own faces or ones every system has, nothing else. */
export const THEME_FONTS = Object.fromEntries(
  Object.entries(THEME_FONT_CHOICES).map(([slot, m]) => [
    slot,
    Object.fromEntries(Object.entries(m).map(([k, f]) => [k, f.stack])),
  ]),
) as { [S in ThemeFontSlot]: Record<keyof (typeof THEME_FONT_CHOICES)[S], string> };

export const TITLE_STYLES = ["italic-serif", "serif", "sans", "display"] as const;
export type TitleStyle = (typeof TITLE_STYLES)[number];
export const TITLE_WEIGHTS = ["light", "regular", "semibold", "bold"] as const;
export const TITLE_CASES = ["normal", "upper"] as const;

/** A theme's shape and layout: named choices compiling to fixed values, gangway's first. */
export const THEME_STYLE = {
  corners: ["square", "soft", "round"],
  edges: ["neatline", "hairline", "shadow", "flat"],
  stroke: ["regular", "light", "bold"],
  nodes: ["outline", "tint", "solid"],
  grid: ["lines", "dots", "none"],
  density: ["regular", "compact", "airy"],
  text: ["regular", "small", "large"],
  headings: ["regular", "modest", "dramatic"],
} as const;
export type ThemeStyleKey = keyof typeof THEME_STYLE;

// A colour, in a syntax a browser reads, and nothing that could end the declaration.
const COLOR =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[-0-9.%\s,/a-z]{1,80}\))$/i;
const color = z
  .string()
  .trim()
  .max(96)
  .refine(
    (v) => COLOR.test(v) && !/[;{}<>"'\\]/.test(v),
    "a colour: #hex, rgb(), hsl() or oklch()",
  );

const tokenMap = z.partialRecord(z.enum(THEME_TOKENS), color);
const fontKey = (slot: ThemeFontSlot) =>
  z.enum(Object.keys(THEME_FONT_CHOICES[slot]) as [string, ...string[]]).optional();

export const ThemeTokensSchema = z.strictObject({ light: tokenMap, dark: tokenMap });
export const ThemeFontsSchema = z.strictObject({
  serif: fontKey("serif"),
  sans: fontKey("sans"),
  mono: fontKey("mono"),
  display: fontKey("display"),
  titles: z.enum(TITLE_STYLES).optional(),
  titleWeight: z.enum(TITLE_WEIGHTS).optional(),
  titleCase: z.enum(TITLE_CASES).optional(),
});
export const ThemeStyleSchema = z.strictObject({
  corners: z.enum(THEME_STYLE.corners).optional(),
  edges: z.enum(THEME_STYLE.edges).optional(),
  stroke: z.enum(THEME_STYLE.stroke).optional(),
  nodes: z.enum(THEME_STYLE.nodes).optional(),
  grid: z.enum(THEME_STYLE.grid).optional(),
  density: z.enum(THEME_STYLE.density).optional(),
  text: z.enum(THEME_STYLE.text).optional(),
  headings: z.enum(THEME_STYLE.headings).optional(),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
export type ThemeFonts = z.infer<typeof ThemeFontsSchema>;
export type ThemeStyle = z.infer<typeof ThemeStyleSchema>;

export const themeId = z
  .string()
  .regex(THEME_ID, "an id is 1-32 lowercase letters, digits and hyphens")
  .refine((v) => v !== HOUSE_THEME, `"${HOUSE_THEME}" is gangway's own theme`);

export const ThemeFieldsSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(300).optional(),
  tokens: ThemeTokensSchema,
  fonts: ThemeFontsSchema.optional(),
  style: ThemeStyleSchema.optional(),
  /** An SVG shown as an image beside titles; scripts and foreign content are stripped. */
  logo: z
    .string()
    .max(64 * 1024)
    .nullable()
    .optional(),
});
export const ThemeCreateSchema = ThemeFieldsSchema.extend({ id: themeId });
export const ThemePatchSchema = ThemeFieldsSchema.partial();
export type ThemeCreate = z.infer<typeof ThemeCreateSchema>;
export type ThemePatch = z.infer<typeof ThemePatchSchema>;

export type Theme = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  tokens: ThemeTokens;
  fonts: ThemeFonts;
  style: ThemeStyle;
  logo: string | null;
};

export const HOUSE: Theme = {
  id: HOUSE_THEME,
  name: "Chart",
  description: "gangway's own look: ivory paper, navy ink, italic serif titles, flag yellow.",
  builtin: true,
  tokens: { light: {}, dark: {} },
  fonts: {},
  style: {},
  logo: null,
};

/** Keeps shapes, paths and text; drops scripts, event handlers, links out and foreign content. */
export function cleanSvg(svg: string): string | null {
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return null;
  return s
    .replace(/<(script|foreignObject|iframe|object|embed|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|foreignObject|iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|xlink:href)\s*=\s*("\s*(?!#)[^"]*"|'\s*(?!#)[^']*')/gi, "");
}

const decls = (m: Partial<Record<ThemeToken, string>>) =>
  Object.entries(m)
    .filter(([k, v]) => (THEME_TOKENS as readonly string[]).includes(k) && v && COLOR.test(v))
    .map(([k, v]) => `--${k}:${v};`)
    .join("");

const TITLES: Record<TitleStyle, string> = {
  "italic-serif": "--font-title:var(--font-serif);--title-style:italic;",
  serif: "--font-title:var(--font-serif);--title-style:normal;",
  sans: "--font-title:var(--font-sans);--title-style:normal;--title-weight:600;",
  display: "--font-title:var(--font-display);--title-style:normal;",
};
const TITLE_WEIGHT: Record<(typeof TITLE_WEIGHTS)[number], string> = {
  light: "--title-weight:300;",
  regular: "--title-weight:400;",
  semibold: "--title-weight:600;",
  bold: "--title-weight:700;",
};
const TITLE_CASE: Record<(typeof TITLE_CASES)[number], string> = {
  normal: "--title-case:none;--title-track:normal;",
  upper: "--title-case:uppercase;--title-track:0.04em;",
};

// What each style choice sets. The first of each is kit.css's own value, spelled out so a
// theme that names it gets exactly gangway's look.
const SHADOW =
  "0 1px 2px color-mix(in oklch, var(--ink) 12%, transparent), 0 6px 20px -6px color-mix(in oklch, var(--ink) 22%, transparent), var(--hairline)";
const GRID_LINES =
  "linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px), linear-gradient(var(--grid-fine) 1px, transparent 1px), linear-gradient(90deg, var(--grid-fine) 1px, transparent 1px)";
// canvas.ts sizes the layers major, major, fine, fine; dots need one of each, so the second
// layer is empty.
const GRID_DOTS =
  "radial-gradient(circle at 1px 1px, var(--grid) 1.25px, transparent 1.75px), linear-gradient(transparent, transparent), radial-gradient(circle at 1px 1px, var(--grid-fine) 1px, transparent 1.5px)";
export const STYLE_CSS: { [K in ThemeStyleKey]: Record<(typeof THEME_STYLE)[K][number], string> } =
  {
    corners: {
      square: "--radius:0px;--radius-sm:0px;",
      soft: "--radius:6px;--radius-sm:3px;",
      round: "--radius:14px;--radius-sm:8px;",
    },
    edges: {
      neatline: "--card-edge:var(--neatline-soft);",
      hairline: "--card-edge:var(--hairline);",
      shadow: `--card-edge:${SHADOW};`,
      flat: "--card-edge:none;",
    },
    stroke: {
      regular: "--stroke:1px;--stroke-n:1;",
      light: "--stroke:1px;--stroke-n:0.7;--stroke-ink:var(--rule);",
      bold: "--stroke:2px;--stroke-n:1.6;",
    },
    nodes: {
      outline: "--node-fill:var(--paper-raised);--node-ink:var(--ink);",
      tint: "--node-fill:color-mix(in oklch, var(--primary) 12%, var(--paper-raised));--node-ink:var(--ink);",
      solid:
        "--node-fill:var(--primary);--node-ink:var(--on-primary);--node-muted:color-mix(in oklch, var(--on-primary) 75%, transparent);",
    },
    grid: {
      lines: `--canvas-grid:${GRID_LINES};`,
      dots: `--canvas-grid:${GRID_DOTS};`,
      none: "--canvas-grid:none;",
    },
    density: {
      regular: "--space:1;",
      compact: "--space:0.8;",
      airy: "--space:1.25;",
    },
    text: {
      regular: "--text:16px;",
      small: "--text:15px;",
      large: "--text:17.5px;",
    },
    headings: {
      regular: "--h-scale:1;",
      modest: "--h-scale:0.85;",
      dramatic: "--h-scale:1.2;",
    },
  };

/** The declarations a theme's style sets, in a fixed order. */
export function styleDecls(style: ThemeStyle): string {
  return (Object.keys(THEME_STYLE) as ThemeStyleKey[])
    .map((k) => {
      const v = style[k];
      return v ? ((STYLE_CSS[k] as Record<string, string>)[v] ?? "") : "";
    })
    .join("");
}

/** The stylesheet the kit loads after its own. `logoUrl` is where the logo is served. */
export function compileTheme(t: Theme, logoUrl?: string): string {
  if (t.builtin) return `/* ${t.name}: gangway's own theme */\n`;
  const f = t.fonts;
  const font = (k: ThemeFontSlot) => {
    const stack = f[k] ? (THEME_FONTS[k] as Record<string, string>)[f[k]] : undefined;
    return stack ? `--font-${k}:${stack};` : "";
  };
  const root =
    decls(t.tokens.light) +
    font("serif") +
    font("sans") +
    font("mono") +
    font("display") +
    (f.titles ? TITLES[f.titles] : "") +
    (f.titleWeight ? TITLE_WEIGHT[f.titleWeight] : "") +
    (f.titleCase ? TITLE_CASE[f.titleCase] : "") +
    styleDecls(t.style ?? {}) +
    (t.logo && logoUrl ? `--logo:url("${logoUrl}");--logo-w:120px;--logo-gap:14px;` : "");
  const lines = [`/* theme: ${t.name.replace(/\*\//g, "")} */`, `:root{${root}}`];
  const dark = decls(t.tokens.dark);
  if (dark) lines.push(`:root[data-theme="dark"]{${dark}}`);
  return `${lines.join("\n")}\n`;
}
