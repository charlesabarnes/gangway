import type {
  ArtifactTheme,
  ThemeFonts,
  ThemeStyle,
  ThemeStyleKey,
  TokenMap,
} from '../../core/artifacts.types';

// The same stylesheet the server compiles (shared/src/artifact/theme.ts), for a theme still
// being edited: the preview shows it before it is saved. server/test/unit/theme-css-parity.test.ts
// holds the two to the same output.

const FONTS: Record<'serif' | 'sans' | 'mono' | 'display', Record<string, string>> = {
  serif: {
    'plex-serif': '"IBM Plex Serif", Georgia, serif',
    'source-serif': '"Source Serif 4", Georgia, serif',
    merriweather: 'Merriweather, Georgia, serif',
    lora: 'Lora, Georgia, serif',
    fraunces: 'Fraunces, Georgia, serif',
    'libre-baskerville': '"Libre Baskerville", Georgia, serif',
    georgia: 'Georgia, "Times New Roman", serif',
    'system-serif': 'ui-serif, "New York", Georgia, serif',
  },
  sans: {
    'plex-sans-condensed': '"IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif',
    'plex-sans': '"IBM Plex Sans", system-ui, sans-serif',
    inter: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    'source-sans': '"Source Sans 3", system-ui, sans-serif',
    manrope: 'Manrope, system-ui, sans-serif',
    'dm-sans': '"DM Sans", system-ui, sans-serif',
    'space-grotesk': '"Space Grotesk", system-ui, sans-serif',
    'system-sans': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  mono: {
    'plex-mono': '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    'jetbrains-mono': '"JetBrains Mono", ui-monospace, Menlo, monospace',
    'fira-code': '"Fira Code", ui-monospace, Menlo, monospace',
    'source-code-pro': '"Source Code Pro", ui-monospace, Menlo, monospace',
    'system-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
  display: {
    'playfair-display': '"Playfair Display", Georgia, serif',
    fraunces: 'Fraunces, Georgia, serif',
    'space-grotesk': '"Space Grotesk", system-ui, sans-serif',
    caveat: 'Caveat, "Comic Sans MS", cursive',
    kalam: 'Kalam, "Comic Sans MS", cursive',
  },
};

const TITLES = {
  'italic-serif': '--font-title:var(--font-serif);--title-style:italic;',
  serif: '--font-title:var(--font-serif);--title-style:normal;',
  sans: '--font-title:var(--font-sans);--title-style:normal;--title-weight:600;',
  display: '--font-title:var(--font-display);--title-style:normal;',
} as const;
const TITLE_WEIGHT = {
  light: '--title-weight:300;',
  regular: '--title-weight:400;',
  semibold: '--title-weight:600;',
  bold: '--title-weight:700;',
} as const;
const TITLE_CASE = {
  normal: '--title-case:none;--title-track:normal;',
  upper: '--title-case:uppercase;--title-track:0.04em;',
} as const;

const SHADOW =
  '0 1px 2px color-mix(in oklch, var(--ink) 12%, transparent), 0 6px 20px -6px color-mix(in oklch, var(--ink) 22%, transparent), var(--hairline)';
const GRID_LINES =
  'linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px), linear-gradient(var(--grid-fine) 1px, transparent 1px), linear-gradient(90deg, var(--grid-fine) 1px, transparent 1px)';
const GRID_DOTS =
  'radial-gradient(circle at 1px 1px, var(--grid) 1.25px, transparent 1.75px), linear-gradient(transparent, transparent), radial-gradient(circle at 1px 1px, var(--grid-fine) 1px, transparent 1.5px)';
const STYLE: Record<ThemeStyleKey, Record<string, string>> = {
  corners: {
    square: '--radius:0px;--radius-sm:0px;',
    soft: '--radius:6px;--radius-sm:3px;',
    round: '--radius:14px;--radius-sm:8px;',
  },
  edges: {
    neatline: '--card-edge:var(--neatline-soft);',
    hairline: '--card-edge:var(--hairline);',
    shadow: `--card-edge:${SHADOW};`,
    flat: '--card-edge:none;',
  },
  stroke: {
    regular: '--stroke:1px;--stroke-n:1;',
    light: '--stroke:1px;--stroke-n:0.7;--stroke-ink:var(--rule);',
    bold: '--stroke:2px;--stroke-n:1.6;',
  },
  nodes: {
    outline: '--node-fill:var(--paper-raised);--node-ink:var(--ink);',
    tint: '--node-fill:color-mix(in oklch, var(--primary) 12%, var(--paper-raised));--node-ink:var(--ink);',
    solid:
      '--node-fill:var(--primary);--node-ink:var(--on-primary);--node-muted:color-mix(in oklch, var(--on-primary) 75%, transparent);',
  },
  grid: {
    lines: `--canvas-grid:${GRID_LINES};`,
    dots: `--canvas-grid:${GRID_DOTS};`,
    none: '--canvas-grid:none;',
  },
  density: { regular: '--space:1;', compact: '--space:0.8;', airy: '--space:1.25;' },
  text: { regular: '--text:16px;', small: '--text:15px;', large: '--text:17.5px;' },
  headings: { regular: '--h-scale:1;', modest: '--h-scale:0.85;', dramatic: '--h-scale:1.2;' },
};

const SAFE = /^[^;{}<>"'\\]{1,96}$/;
const decls = (m: TokenMap) =>
  Object.entries(m)
    .filter(([, v]) => v && SAFE.test(v))
    .map(([k, v]) => `--${k}:${v};`)
    .join('');

/** The declarations a style sets, in the server's order. */
export function styleDecls(style: ThemeStyle): string {
  return (Object.keys(STYLE) as ThemeStyleKey[])
    .map((k) => {
      const v = style[k];
      return v ? (STYLE[k][v] ?? '') : '';
    })
    .join('');
}

export function themeCss(
  t: Pick<ArtifactTheme, 'builtin' | 'tokens' | 'fonts' | 'logo'> & { style?: ThemeStyle },
): string {
  if (t.builtin) return '';
  const f: ThemeFonts = t.fonts;
  const font = (k: 'serif' | 'sans' | 'mono' | 'display') => {
    const stack = f[k] ? FONTS[k][f[k]!] : undefined;
    return stack ? `--font-${k}:${stack};` : '';
  };
  const logo = t.logo
    ? `--logo:url("data:image/svg+xml,${encodeURIComponent(t.logo)}");--logo-w:120px;--logo-gap:14px;`
    : '';
  const root =
    decls(t.tokens.light) +
    font('serif') +
    font('sans') +
    font('mono') +
    font('display') +
    (f.titles ? TITLES[f.titles] : '') +
    (f.titleWeight ? TITLE_WEIGHT[f.titleWeight] : '') +
    (f.titleCase ? TITLE_CASE[f.titleCase] : '') +
    styleDecls(t.style ?? {}) +
    logo;
  const dark = decls(t.tokens.dark);
  return `:root{${root}}` + (dark ? `:root[data-theme="dark"]{${dark}}` : '');
}
