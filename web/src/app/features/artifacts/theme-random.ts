import type { ThemeFonts, ThemeStyle, TokenMap } from '../../core/artifacts.types';
import { derivePalette } from './palette';

// A "random" theme: one of a few looks that hang together (type, shape and layout chosen as a
// set), recoloured from a random hue. Random per look, not per setting, so every result reads
// as something a designer might have made rather than a slot machine.

type Rng = () => number;

type Look = {
  name: string;
  fonts: { [K in keyof ThemeFonts]?: readonly NonNullable<ThemeFonts[K]>[] };
  style: ThemeStyle;
  /** Paper lightness and chroma; the brand colour's lightness and chroma. */
  paper: [number, number];
  primary: [number, number];
  /** How far round the wheel the highlight sits from the brand hue. */
  flagTurn: readonly number[];
};

export const LOOKS: readonly Look[] = [
  {
    name: 'Editorial',
    fonts: {
      serif: ['source-serif', 'libre-baskerville', 'lora'],
      sans: ['source-sans', 'plex-sans'],
      display: ['playfair-display', 'fraunces'],
      titles: ['display'],
      titleWeight: ['regular', 'semibold'],
    },
    style: {
      corners: 'square',
      edges: 'hairline',
      nodes: 'outline',
      grid: 'none',
      density: 'airy',
      text: 'large',
      headings: 'dramatic',
    },
    paper: [0.97, 0.015],
    primary: [0.4, 0.12],
    flagTurn: [30, 180],
  },
  {
    name: 'Product',
    fonts: {
      sans: ['inter', 'manrope', 'dm-sans'],
      titles: ['sans'],
      titleWeight: ['bold', 'semibold'],
    },
    style: {
      corners: 'round',
      edges: 'shadow',
      stroke: 'light',
      nodes: 'tint',
      grid: 'dots',
    },
    paper: [0.985, 0.004],
    primary: [0.5, 0.19],
    flagTurn: [150, 180, 200],
  },
  {
    name: 'Terminal',
    fonts: {
      sans: ['space-grotesk', 'plex-sans'],
      mono: ['jetbrains-mono', 'fira-code'],
      display: ['space-grotesk'],
      titles: ['display'],
      titleWeight: ['bold'],
      titleCase: ['upper'],
    },
    style: {
      corners: 'square',
      edges: 'flat',
      stroke: 'bold',
      nodes: 'solid',
      grid: 'lines',
      density: 'compact',
      text: 'small',
      headings: 'modest',
    },
    paper: [0.96, 0.01],
    primary: [0.5, 0.17],
    flagTurn: [120, 180],
  },
  {
    name: 'Notebook',
    fonts: {
      serif: ['lora', 'merriweather'],
      sans: ['dm-sans', 'source-sans'],
      display: ['caveat', 'kalam'],
      titles: ['display'],
      titleWeight: ['bold'],
    },
    style: { corners: 'soft', edges: 'hairline', nodes: 'tint', grid: 'dots' },
    paper: [0.965, 0.02],
    primary: [0.45, 0.13],
    flagTurn: [40, 160],
  },
  {
    name: 'Corporate',
    fonts: {
      serif: ['source-serif'],
      sans: ['plex-sans', 'source-sans'],
      titles: ['sans'],
      titleWeight: ['semibold'],
    },
    style: {
      corners: 'soft',
      edges: 'hairline',
      nodes: 'outline',
      grid: 'none',
      density: 'compact',
      headings: 'modest',
    },
    paper: [0.98, 0.006],
    primary: [0.45, 0.13],
    flagTurn: [180, 200],
  },
  {
    name: 'Minimal',
    fonts: {
      sans: ['inter', 'manrope'],
      titles: ['sans'],
      titleWeight: ['light', 'regular'],
    },
    style: {
      corners: 'soft',
      edges: 'flat',
      stroke: 'light',
      nodes: 'outline',
      grid: 'none',
      density: 'airy',
      headings: 'dramatic',
    },
    paper: [0.99, 0.002],
    primary: [0.35, 0.08],
    flagTurn: [150, 180],
  },
  {
    name: 'Magazine',
    fonts: {
      serif: ['fraunces', 'source-serif'],
      sans: ['dm-sans'],
      display: ['fraunces', 'playfair-display'],
      titles: ['display'],
      titleWeight: ['bold'],
      titleCase: ['upper'],
    },
    style: {
      corners: 'square',
      edges: 'flat',
      stroke: 'bold',
      nodes: 'solid',
      grid: 'none',
      headings: 'dramatic',
    },
    paper: [0.96, 0.02],
    primary: [0.46, 0.2],
    flagTurn: [60, 180],
  },
  {
    name: 'Chart',
    fonts: { titles: ['italic-serif'] },
    style: {},
    paper: [0.97, 0.012],
    primary: [0.33, 0.09],
    flagTurn: [190],
  },
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

const pick = <T>(xs: readonly T[], rng: Rng): T => xs[Math.floor(rng() * xs.length)]!;

export function hueName(h: number): string {
  return HUES.find(([top]) => h < top)?.[1] ?? 'Rose';
}

/** Light and dark colours from a brand hue, in a look's weights. */
export function palette(look: Look, h: number, rng: Rng): { light: TokenMap; dark: TokenMap } {
  const [pl, pc] = look.paper;
  const [prl, prc] = look.primary;
  return derivePalette({
    primary: { l: prl, c: prc, h },
    flag: { l: 0.82, c: 0.14, h: (h + pick(look.flagTurn, rng)) % 360 },
    paper: { l: pl, c: pc, h },
  });
}

export type RandomTheme = {
  name: string;
  look: string;
  tokens: { light: TokenMap; dark: TokenMap };
  fonts: ThemeFonts;
  style: ThemeStyle;
};

/** A theme in one of the looks, never the look it is given as `after`. */
export function randomTheme(rng: Rng = Math.random, after?: string): RandomTheme {
  const looks = LOOKS.filter((l) => l.name !== after);
  const look = pick(looks, rng);
  const h = Math.floor(rng() * 360);
  const fonts: ThemeFonts = {};
  for (const [k, choices] of Object.entries(look.fonts))
    (fonts as Record<string, string>)[k] = pick(choices as readonly string[], rng);
  return {
    name: `${look.name} ${hueName(h)}`,
    look: look.name,
    tokens: palette(look, h, rng),
    fonts,
    style: { ...look.style },
  };
}
