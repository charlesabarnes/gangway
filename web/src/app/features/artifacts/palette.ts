import type { ThemeToken, TokenMap } from '../../core/artifacts.types';
import { contrast, oklch, parseColor, toOklch, type Oklch } from './color';

// Every token for light and dark from the brand colour, the highlight and the paper: greys
// lean the brand's hue, and text on a colour is whichever of white and near-black reads better.

export type PaperTone = 'white' | 'tinted' | 'warm';

export type PaletteSpec = {
  /** The brand colour; `exact` is kept as written for light mode's primary. */
  primary: Oklch & { exact?: string };
  flag: Oklch & { exact?: string };
  paper: Oklch;
};

const onColour = (bg: string, h: number) => {
  const light = oklch(1, 0, h);
  const dark = oklch(0.22, 0.04, h);
  return (contrast(light, bg) ?? 0) >= (contrast(dark, bg) ?? 0) ? light : dark;
};

export function derivePalette(p: PaletteSpec): { light: TokenMap; dark: TokenMap } {
  const h = p.primary.h;
  const f = p.flag.h;
  const primary = p.primary.exact ?? oklch(p.primary.l, p.primary.c, h);
  const flag = p.flag.exact ?? oklch(p.flag.l, p.flag.c, f);
  const darkPrimary = oklch(Math.max(p.primary.l, 0.78), Math.min(p.primary.c, 0.14), h);
  const series = (l: number, c: number) =>
    [60, 120, 240, 300].map((turn) => oklch(l, c, h + turn + 15)) as [
      string,
      string,
      string,
      string,
    ];
  const [s3, s4, s5, s6] = series(0.6, 0.13);
  const [d3, d4, d5, d6] = series(0.74, 0.12);
  const light: Record<ThemeToken, string> = {
    paper: oklch(p.paper.l, p.paper.c, p.paper.h),
    'paper-raised': oklch(Math.min(p.paper.l + 0.02, 0.995), p.paper.c / 2, p.paper.h),
    ink: oklch(0.25, 0.04, h),
    'ink-muted': oklch(0.47, 0.03, h),
    rule: oklch(0.86, 0.02, h),
    primary,
    'on-primary': onColour(primary, h),
    flag,
    'on-flag': onColour(flag, h),
    awake: oklch(0.58, 0.13, 155),
    warn: oklch(0.6, 0.13, 70),
    danger: oklch(0.55, 0.19, 28),
    'header-bg': oklch(0.26, Math.min(p.primary.c, 0.08), h),
    'header-fg': oklch(0.97, 0.01, h),
    'header-muted': oklch(0.76, 0.03, h),
    'header-rule': oklch(0.4, 0.05, h),
    'log-bg': oklch(0.2, 0.03, h),
    'log-fg': oklch(0.94, 0.01, h),
    s1: primary,
    s2: oklch(Math.min(p.flag.l, 0.74), p.flag.c, f),
    s3,
    s4,
    s5,
    s6,
  };
  const dark: Record<ThemeToken, string> = {
    paper: oklch(0.2, 0.03, h),
    'paper-raised': oklch(0.25, 0.035, h),
    ink: oklch(0.94, 0.012, h),
    'ink-muted': oklch(0.72, 0.03, h),
    rule: oklch(0.36, 0.04, h),
    primary: darkPrimary,
    'on-primary': onColour(darkPrimary, h),
    flag,
    'on-flag': onColour(flag, h),
    awake: oklch(0.75, 0.14, 155),
    warn: oklch(0.8, 0.13, 75),
    danger: oklch(0.64, 0.18, 28),
    'header-bg': oklch(0.15, 0.03, h),
    'header-fg': oklch(0.94, 0.012, h),
    'header-muted': oklch(0.72, 0.03, h),
    'header-rule': oklch(0.32, 0.04, h),
    'log-bg': oklch(0.14, 0.03, h),
    'log-fg': oklch(0.94, 0.012, h),
    s1: darkPrimary,
    s2: oklch(Math.max(p.flag.l, 0.8), p.flag.c, f),
    s3: d3,
    s4: d4,
    s5: d5,
    s6: d6,
  };
  return { light, dark };
}

const PAPER: Record<PaperTone, (h: number) => Oklch> = {
  white: (h) => ({ l: 0.99, c: 0.003, h }),
  tinted: (h) => ({ l: 0.975, c: 0.012, h }),
  warm: () => ({ l: 0.97, c: 0.015, h: 85 }),
};

/** From a brand colour and an optional second one (else the opposite hue); null if unreadable. */
export function brandPalette(
  brand: string,
  accent: string | null,
  paper: PaperTone,
): { light: TokenMap; dark: TokenMap } | null {
  const main = parseColor(brand);
  if (!main) return null;
  const p = toOklch(main);
  const page = PAPER[paper](p.h);
  const second = accent ? parseColor(accent) : null;
  // A brand colour too light for links on the page becomes the highlight; a deeper shade leads.
  const light = (contrast(brand, oklch(page.l, page.c, page.h)) ?? 0) < 3;
  const primary: PaletteSpec['primary'] = light
    ? { l: 0.4, c: Math.min(p.c, 0.12), h: p.h }
    : { ...p, exact: brand.trim() };
  let flag: PaletteSpec['flag'] = { l: 0.82, c: 0.14, h: p.h + 180 };
  if (second) flag = { ...toOklch(second), exact: accent!.trim() };
  else if (light) flag = { ...p, exact: brand.trim() };
  return derivePalette({ primary, flag, paper: page });
}
