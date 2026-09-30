import type { ThemeFonts, ThemeStyle, TokenMap } from '../../core/artifacts.types';
import { derivePalette } from './palette';
import { FONTS } from './theme-css';

// A random theme, every part drawn on its own (fonts, titles, each shape and layout setting,
// the colour scheme) with a few rules to keep it sensible: no uppercase or light handwriting,
// round corners lean to soft edges, the brand colour stays dark enough to read.

type Rng = () => number;
/** Choices with weights; a missing weight is 1. */
type Weighted<T extends string> = Partial<Record<T, number>>;

const pick = <T>(xs: readonly T[], rng: Rng): T => xs[Math.floor(rng() * xs.length)]!;

function weighted<T extends string>(w: Weighted<T>, rng: Rng): T {
  const entries = Object.entries(w) as [T, number][];
  let at = rng() * entries.reduce((s, [, n]) => s + n, 0);
  for (const [k, n] of entries) if ((at -= n) < 0) return k;
  return entries.at(-1)![0];
}

const keys = (slot: keyof typeof FONTS) => Object.keys(FONTS[slot]);
const HAND = new Set(['caveat', 'kalam']);

export function randomFonts(rng: Rng): ThemeFonts {
  const fonts: ThemeFonts = {
    serif: pick(keys('serif'), rng),
    sans: pick(keys('sans'), rng),
    mono: pick(keys('mono'), rng),
  };
  const titles = weighted({ 'italic-serif': 1, serif: 1.2, sans: 1.5, display: 2 } as const, rng);
  fonts.titles = titles;
  if (titles === 'display') {
    fonts.display = pick(keys('display'), rng);
    const hand = HAND.has(fonts.display);
    fonts.titleWeight = hand
      ? weighted({ regular: 1, bold: 2 } as const, rng)
      : weighted({ regular: 2, semibold: 1, bold: 2 } as const, rng);
    if (!hand && rng() < 0.3) fonts.titleCase = 'upper';
  } else if (titles === 'sans') {
    fonts.titleWeight = weighted({ light: 1, regular: 1, semibold: 2, bold: 2 } as const, rng);
    if (rng() < 0.25) fonts.titleCase = 'upper';
  } else {
    fonts.titleWeight = weighted({ regular: 3, semibold: 1 } as const, rng);
    if (titles === 'serif' && rng() < 0.15) fonts.titleCase = 'upper';
  }
  return fonts;
}

export function randomStyle(rng: Rng): ThemeStyle {
  const corners = weighted({ square: 1, soft: 1.2, round: 1 } as const, rng);
  const edges =
    corners === 'square'
      ? weighted({ neatline: 2, hairline: 2, flat: 1.5, shadow: 0.5 } as const, rng)
      : weighted({ neatline: 0.3, hairline: 2, flat: 1.2, shadow: 2 } as const, rng);
  const around = <T extends string>(house: T, others: T[]) =>
    weighted({ [house]: 2, ...Object.fromEntries(others.map((o) => [o, 1])) } as Weighted<T>, rng);
  return {
    corners,
    edges,
    stroke: around('regular', ['light', 'bold']),
    nodes: weighted({ outline: 1, tint: 1.3, solid: 0.8 }, rng),
    grid: weighted({ lines: 1, dots: 1.2, none: 1 }, rng),
    density: around('regular', ['compact', 'airy']),
    text: around('regular', ['small', 'large']),
    headings: around('regular', ['modest', 'dramatic']),
  };
}

// How far round the wheel the highlight sits from the brand: complementary, split,
// triadic, analogous, or the brand's own hue lighter.
const SCHEMES: Record<string, readonly number[]> = {
  complementary: [180],
  split: [150, 210],
  triadic: [120, 240],
  analogous: [30, -30, 45, -45],
  mono: [0],
};

export function randomColours(h: number, rng: Rng): { light: TokenMap; dark: TokenMap } {
  const turn = pick(
    SCHEMES[weighted({ complementary: 2, split: 2, triadic: 1.5, analogous: 1.5, mono: 1 }, rng)]!,
    rng,
  );
  const strength = weighted({ muted: 1, medium: 2, vivid: 1.5 }, rng);
  const c = { muted: 0.07, medium: 0.12, vivid: 0.18 }[strength] + (rng() - 0.5) * 0.03;
  const paper = weighted({ white: 1.5, tinted: 2, warm: 1.2, washed: 0.8 }, rng);
  const page = {
    white: { l: 0.99, c: 0.003, h },
    tinted: { l: 0.975, c: 0.012, h },
    warm: { l: 0.97, c: 0.016, h: 80 + rng() * 15 },
    washed: { l: 0.955, c: 0.028, h },
  }[paper];
  return derivePalette({
    // 0.34-0.5 keeps the brand colour 3:1 or better on any of the papers.
    primary: { l: 0.34 + rng() * 0.16, c, h },
    flag: {
      l: turn === 0 ? 0.86 : 0.76 + rng() * 0.1,
      c: 0.1 + rng() * 0.07,
      h: (h + turn + 360) % 360,
    },
    paper: page,
  });
}

const WORDS = [
  'Atlas',
  'Bright',
  'Civic',
  'Crisp',
  'Dawn',
  'Field',
  'Folio',
  'Ledger',
  'Lumen',
  'Margin',
  'Meridian',
  'Night',
  'North',
  'Quiet',
  'Signal',
  'Slate',
  'Studio',
  'Summit',
  'Tide',
];

const HUES: [number, string][] = [
  [15, 'Rose'],
  [35, 'Ember'],
  [60, 'Amber'],
  [95, 'Olive'],
  [140, 'Moss'],
  [175, 'Teal'],
  [210, 'Harbour'],
  [245, 'Cobalt'],
  [275, 'Indigo'],
  [305, 'Violet'],
  [335, 'Plum'],
  [360, 'Rose'],
];

export function hueName(h: number): string {
  return HUES.find(([top]) => h < top)?.[1] ?? 'Rose';
}

export type RandomTheme = {
  name: string;
  /** The name's first word, kept when only the colours change. */
  word: string;
  tokens: { light: TokenMap; dark: TokenMap };
  fonts: ThemeFonts;
  style: ThemeStyle;
};

export function randomTheme(rng: Rng = Math.random): RandomTheme {
  const h = Math.floor(rng() * 360);
  const word = pick(WORDS, rng);
  return {
    name: `${word} ${hueName(h)}`,
    word,
    tokens: randomColours(h, rng),
    fonts: randomFonts(rng),
    style: randomStyle(rng),
  };
}
