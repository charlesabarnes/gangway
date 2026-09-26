import type { ArtifactTheme, ThemeFonts, TokenMap } from '../../core/artifacts.types';

// The same stylesheet the server compiles (shared/src/artifact/theme.ts), for a theme still
// being edited: the preview shows it before it is saved.

const FONTS: Record<'serif' | 'sans' | 'mono', Record<string, string>> = {
  serif: {
    'plex-serif': '"IBM Plex Serif", Georgia, serif',
    georgia: 'Georgia, "Times New Roman", serif',
    'system-serif': 'ui-serif, "New York", Georgia, serif',
  },
  sans: {
    'plex-sans-condensed': '"IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif',
    inter: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    'system-sans': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  mono: {
    'plex-mono': '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    'system-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
};

const TITLES = {
  'italic-serif': '--font-title:var(--font-serif);--title-style:italic;',
  serif: '--font-title:var(--font-serif);--title-style:normal;',
  sans: '--font-title:var(--font-sans);--title-style:normal;--title-weight:600;',
} as const;

const SAFE = /^[^;{}<>"'\\]{1,96}$/;
const decls = (m: TokenMap) =>
  Object.entries(m)
    .filter(([, v]) => v && SAFE.test(v))
    .map(([k, v]) => `--${k}:${v};`)
    .join('');

export function themeCss(t: Pick<ArtifactTheme, 'builtin' | 'tokens' | 'fonts' | 'logo'>): string {
  if (t.builtin) return '';
  const f: ThemeFonts = t.fonts;
  const font = (k: 'serif' | 'sans' | 'mono') => {
    const stack = f[k] ? FONTS[k][f[k]!] : undefined;
    return stack ? `--font-${k}:${stack};` : '';
  };
  const logo = t.logo
    ? `--logo:url("data:image/svg+xml,${encodeURIComponent(t.logo)}");--logo-w:120px;--logo-gap:14px;`
    : '';
  const root = decls(t.tokens.light) + font('serif') + font('sans') + font('mono');
  const dark = decls(t.tokens.dark);
  return (
    `:root{${root}${f.titles ? TITLES[f.titles] : ''}${logo}}` +
    (dark ? `:root[data-theme="dark"]{${dark}}` : '')
  );
}
