import type { ThemeStyleKey, ThemeToken } from '../../core/artifacts.types';
import { parseColor, toHex } from './color';

// How the theme editor groups the tokens and names the fonts.

export const GROUPS: { title: string; tokens: ThemeToken[] }[] = [
  { title: 'Paper and ink', tokens: ['paper', 'paper-raised', 'ink', 'ink-muted', 'rule'] },
  { title: 'Accent', tokens: ['flag', 'on-flag', 'primary', 'on-primary'] },
  { title: 'Signals', tokens: ['awake', 'warn', 'danger'] },
  { title: 'Navy slides', tokens: ['header-bg', 'header-fg', 'header-muted', 'header-rule'] },
  { title: 'Code', tokens: ['log-bg', 'log-fg'] },
  { title: 'Chart series', tokens: ['s1', 's2', 's3', 's4', 's5', 's6'] },
];

// Font names come with the theme list (fontLabels); these name the other choices.
export const CHOICE_NAMES: Record<string, string> = {
  'italic-serif': 'Italic serif (gangway)',
  serif: 'Upright serif',
  sans: 'Sans, semibold',
  display: 'Display font',
  light: 'Light',
  regular: 'Regular',
  semibold: 'Semibold',
  bold: 'Bold',
  normal: 'As written',
  upper: 'Uppercase',
};

/** The shape and layout controls, in the order the editor shows them. */
export const STYLE_FIELDS: { key: ThemeStyleKey; label: string; group: 'Shape' | 'Layout' }[] = [
  { key: 'corners', label: 'Corners', group: 'Shape' },
  { key: 'edges', label: 'Card edges', group: 'Shape' },
  { key: 'stroke', label: 'Line weight', group: 'Shape' },
  { key: 'nodes', label: 'Flowchart nodes', group: 'Shape' },
  { key: 'grid', label: 'Canvas grid', group: 'Shape' },
  { key: 'density', label: 'Spacing', group: 'Layout' },
  { key: 'text', label: 'Text size', group: 'Layout' },
  { key: 'headings', label: 'Headings', group: 'Layout' },
];

/** A colour input needs #rrggbb: any colour this can read, else black (it still shows as a swatch). */
export const hexOf = (v: string) => {
  const rgb = parseColor(v);
  return rgb ? toHex(rgb) : '#000000';
};
