// Colours as a theme writes them (#hex, rgb(), hsl(), oklch(), oklab()), read into sRGB for
// contrast and for the swatch pickers, and sRGB back into oklch for deriving a palette.

export type Rgb = { r: number; g: number; b: number };
export type Oklch = { l: number; c: number; h: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp01(fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  };
}

export function toOklch({ r, g, b }: Rgb): Oklch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: (h + 360) % 360 };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0), g: f(8), b: f(4) };
}

// A number, a percentage of `whole`, or "none".
const num = (v: string, whole = 1) => {
  if (v === 'none') return 0;
  return v.endsWith('%') ? (Number.parseFloat(v) / 100) * whole : Number.parseFloat(v);
};

/** The colour in sRGB, or null for a syntax this does not read (lab(), lch(), a typo). */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    if (full.length !== 6 && full.length !== 8) return null;
    const at = (i: number) => Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return { r: at(0), g: at(2), b: at(4) };
  }
  const fn = /^(rgba?|hsla?|oklch|oklab)\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [x, y, z] = parts as [string, string, string];
  let out: Rgb;
  switch (fn[1]) {
    case 'rgb':
    case 'rgba':
      out = { r: num(x, 255) / 255, g: num(y, 255) / 255, b: num(z, 255) / 255 };
      break;
    case 'hsl':
    case 'hsla':
      out = hslToRgb(
        Number.parseFloat(x),
        num(y.endsWith('%') ? y : `${y}%`),
        num(z.endsWith('%') ? z : `${z}%`),
      );
      break;
    case 'oklch': {
      const h = (Number.parseFloat(z) * Math.PI) / 180;
      const c = num(y, 0.4);
      out = oklabToRgb(num(x), c * Math.cos(h), c * Math.sin(h));
      break;
    }
    default:
      out = oklabToRgb(num(x), num(y, 0.4), num(z, 0.4));
  }
  return Object.values(out).some(Number.isNaN)
    ? null
    : { r: clamp01(out.r), g: clamp01(out.g), b: clamp01(out.b) };
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(clamp01(v) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export const oklch = (l: number, c: number, h: number) =>
  `oklch(${+l.toFixed(3)} ${+c.toFixed(3)} ${+(((h % 360) + 360) % 360).toFixed(1)})`;

const luminance = ({ r, g, b }: Rgb) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

/** The WCAG contrast ratio of two colours, or null when either cannot be read. */
export function contrast(a: string, b: string): number | null {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
