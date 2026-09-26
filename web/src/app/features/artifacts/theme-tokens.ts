import type { ThemeToken } from '../../core/artifacts.types';

// How the theme editor groups the tokens and names the fonts.

export const GROUPS: { title: string; tokens: ThemeToken[] }[] = [
  { title: 'Paper and ink', tokens: ['paper', 'paper-raised', 'ink', 'ink-muted', 'rule'] },
  { title: 'Accent', tokens: ['flag', 'on-flag', 'primary', 'on-primary'] },
  { title: 'Signals', tokens: ['awake', 'warn', 'danger'] },
  { title: 'Navy slides', tokens: ['header-bg', 'header-fg', 'header-muted', 'header-rule'] },
  { title: 'Code', tokens: ['log-bg', 'log-fg'] },
  { title: 'Chart series', tokens: ['s1', 's2', 's3', 's4', 's5', 's6'] },
];

export const FONT_NAMES: Record<string, string> = {
  'plex-serif': 'IBM Plex Serif',
  georgia: 'Georgia',
  'system-serif': 'System serif',
  'plex-sans-condensed': 'IBM Plex Sans Condensed',
  inter: 'Inter',
  'system-sans': 'System sans',
  'plex-mono': 'IBM Plex Mono',
  'system-mono': 'System mono',
  'italic-serif': 'Italic serif (gangway)',
  serif: 'Upright serif',
  sans: 'Sans, semibold',
};

/** A colour input needs #rrggbb; anything else starts it at black but still shows as a swatch. */
export const hexOf = (v: string) =>
  /^#[0-9a-f]{6}$/i.test(v)
    ? v
    : /^#[0-9a-f]{3}$/i.test(v)
      ? `#${[...v.slice(1)].map((c) => c + c).join('')}`
      : '#000000';
