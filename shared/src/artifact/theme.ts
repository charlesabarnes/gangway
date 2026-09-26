import { z } from "zod";
import { HOUSE_THEME, THEME_ID } from "./vocab.ts";

// A theme is a set of the kit's tokens for light and dark, three font choices, a title style
// and an optional logo. It compiles to a small stylesheet the kit loads after its own, so a
// theme can only change what the tokens reach: no selectors and no free CSS.

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

/** Fonts the kit ships or every system has; a theme picks from these and nothing else. */
export const THEME_FONTS = {
  serif: {
    "plex-serif": '"IBM Plex Serif", Georgia, serif',
    georgia: 'Georgia, "Times New Roman", serif',
    "system-serif": 'ui-serif, "New York", Georgia, serif',
  },
  sans: {
    "plex-sans-condensed": '"IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif',
    inter: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    "system-sans": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  mono: {
    "plex-mono": '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    "system-mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
} as const;

export const TITLE_STYLES = ["italic-serif", "serif", "sans"] as const;
export type TitleStyle = (typeof TITLE_STYLES)[number];

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

export const ThemeTokensSchema = z.strictObject({ light: tokenMap, dark: tokenMap });
export const ThemeFontsSchema = z.strictObject({
  serif: z.enum(Object.keys(THEME_FONTS.serif) as [string, ...string[]]).optional(),
  sans: z.enum(Object.keys(THEME_FONTS.sans) as [string, ...string[]]).optional(),
  mono: z.enum(Object.keys(THEME_FONTS.mono) as [string, ...string[]]).optional(),
  titles: z.enum(TITLE_STYLES).optional(),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
export type ThemeFonts = z.infer<typeof ThemeFontsSchema>;

export const themeId = z
  .string()
  .regex(THEME_ID, "an id is 1-32 lowercase letters, digits and hyphens")
  .refine((v) => v !== HOUSE_THEME, `"${HOUSE_THEME}" is gangway's own theme`);

export const ThemeFieldsSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(300).optional(),
  tokens: ThemeTokensSchema,
  fonts: ThemeFontsSchema.optional(),
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
  logo: string | null;
};

export const HOUSE: Theme = {
  id: HOUSE_THEME,
  name: "Chart",
  description: "gangway's own look: ivory paper, navy ink, italic serif titles, flag yellow.",
  builtin: true,
  tokens: { light: {}, dark: {} },
  fonts: {},
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
};

/** The stylesheet the kit loads after its own. `logoUrl` is where the logo is served. */
export function compileTheme(t: Theme, logoUrl?: string): string {
  if (t.builtin) return `/* ${t.name}: gangway's own theme */\n`;
  const f = t.fonts;
  const font = (k: "serif" | "sans" | "mono") => {
    const stack = f[k] ? (THEME_FONTS[k] as Record<string, string>)[f[k]] : undefined;
    return stack ? `--font-${k}:${stack};` : "";
  };
  const root =
    decls(t.tokens.light) +
    font("serif") +
    font("sans") +
    font("mono") +
    (f.titles ? TITLES[f.titles] : "") +
    (t.logo && logoUrl ? `--logo:url("${logoUrl}");--logo-w:120px;--logo-gap:14px;` : "");
  const lines = [`/* theme: ${t.name.replace(/\*\//g, "")} */`, `:root{${root}}`];
  const dark = decls(t.tokens.dark);
  if (dark) lines.push(`:root[data-theme="dark"]{${dark}}`);
  return `${lines.join("\n")}\n`;
}
