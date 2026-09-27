import type { ThemeToken, TokenMap } from '../../core/artifacts.types';
import { contrast } from './color';

// The pairs of colours an artifact sets text in, and the WCAG contrast each needs: 7:1 for body
// text (AAA, since artifacts are read at length), 4.5:1 for everything else read as text, 3:1
// for the brand colour as a line or a bar on the page.

export type Check = { fg: ThemeToken; bg: ThemeToken; min: number; what: string };

export const CHECKS: readonly Check[] = [
  { fg: 'ink', bg: 'paper', min: 7, what: 'Body text' },
  { fg: 'ink', bg: 'paper-raised', min: 7, what: 'Text on cards' },
  { fg: 'ink-muted', bg: 'paper', min: 4.5, what: 'Captions and labels' },
  { fg: 'primary', bg: 'paper', min: 3, what: 'Brand colour on the page' },
  { fg: 'on-primary', bg: 'primary', min: 4.5, what: 'Text on the brand colour' },
  { fg: 'on-flag', bg: 'flag', min: 4.5, what: 'Text on the highlight' },
  { fg: 'header-fg', bg: 'header-bg', min: 4.5, what: 'Title slides' },
  { fg: 'log-fg', bg: 'log-bg', min: 4.5, what: 'Code blocks' },
];

export type Finding = Check & { mode: 'light' | 'dark'; ratio: number };

/** The checks a theme fails, a token it leaves out taking gangway's value. */
export function readability(
  tokens: { light: TokenMap; dark: TokenMap },
  house: { light: TokenMap; dark: TokenMap },
): Finding[] {
  const out: Finding[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const value = (t: ThemeToken) => tokens[mode][t] || house[mode][t] || '';
    for (const c of CHECKS) {
      const ratio = contrast(value(c.fg), value(c.bg));
      if (ratio !== null && ratio < c.min) out.push({ ...c, mode, ratio });
    }
  }
  return out;
}
