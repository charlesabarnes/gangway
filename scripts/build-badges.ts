// Writes the README badges into site/badges. Text is drawn as outlines, because a README shows an
// SVG as an image, and an image cannot load IBM Plex.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import opentype, { type Font, type Glyph } from "opentype.js";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT = path.join(ROOT, "site", "badges");

function font(pkg: string, file: string): Font {
  const at = Bun.resolveSync(`@fontsource/${pkg}/files/${file}`, path.join(ROOT, "web"));
  const bytes = readFileSync(at);
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}
const SANS = font("ibm-plex-sans-condensed", "ibm-plex-sans-condensed-latin-600-normal.woff");
const MONO = font("ibm-plex-mono", "ibm-plex-mono-latin-600-normal.woff");

const INK = "#1F3353";
const DEEP = "#1C2E4F";
const PAPER = "#F8F4EB";
const FLAG = "#E9C33F";
const RED = "#C8352B";

const LABEL = "DEPLOYED ON";
const WORD = "gangway";
const TITLE = "Deployed on gangway";

interface Run {
  d: string;
  width: number;
}

function text(face: Font, value: string, size: number, tracking: number): Run {
  const scale = size / face.unitsPerEm;
  let x = 0;
  let d = "";
  let previous: Glyph | undefined;
  for (const glyph of face.stringToGlyphs(value)) {
    if (previous) {
      x += face.getKerningValue(previous, glyph) * scale + tracking;
    }
    d += glyph.getPath(x, 0, size).toPathData(1);
    x += (glyph.advanceWidth ?? 0) * scale;
    previous = glyph;
  }
  return { d, width: x };
}

function place(run: Run, x: number, y: number, fill: string): string {
  return `<path transform="translate(${x.toFixed(2)} ${y})" fill="${fill}" d="${run.d}"/>`;
}

function mark(transform: string, ground: string, cargo: string): string {
  return (
    `<g transform="${transform}">` +
    `<rect x="10.5" y="6" width="11" height="6" fill="${FLAG}"/>` +
    `<rect x="4" y="14" width="11" height="6" fill="${RED}"/>` +
    `<rect x="17" y="14" width="11" height="6" fill="${cargo}"/>` +
    `<path stroke="${ground}" stroke-width="0.8" d="M13.5 7.5v3M16 7.5v3M18.5 7.5v3M7 15.5v3M9.5 15.5v3M12 15.5v3M20 15.5v3M22.5 15.5v3M25 15.5v3"/>` +
    `<polygon points="2,22 30,22 26,28 6,28" fill="${cargo}"/></g>`
  );
}

function svg(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${TITLE}">` +
    `<title>${TITLE}</title>${body}</svg>\n`
  );
}

interface Small {
  left: string;
  right: string;
  ground: string;
  cargo: string;
  label: string;
  word: string;
  outline?: string;
}

function small(c: Small): string {
  const label = text(SANS, LABEL, 9.5, 0.8);
  const word = text(MONO, WORD, 11.5, -0.4);
  const left = Math.round(24 + label.width + 6);
  const width = Math.round(left + 7 + word.width + 7);
  return svg(
    width,
    20,
    `<rect width="${left}" height="20" fill="${c.left}"/>` +
      `<rect x="${left}" width="${width - left}" height="20" fill="${c.right}"/>` +
      (c.outline
        ? `<rect x="0.5" y="0.5" width="${width - 1}" height="19" fill="none" stroke="${c.outline}"/>`
        : "") +
      mark("translate(4 2) scale(0.5)", c.ground, c.cargo) +
      place(label, 24, 13.6, c.label) +
      place(word, left + 7, 14, c.word),
  );
}

interface Large {
  ground: string;
  rule: string;
  cargo: string;
  word: string;
  flag?: boolean;
}

function large(c: Large): string {
  const label = text(SANS, LABEL, 11, 1.4);
  const word = text(MONO, WORD, 14, -0.55);
  const divide = Math.round(39 + label.width + 9);
  const width = Math.round(divide + 10.5 + word.width + 16);
  return svg(
    width,
    36,
    `<rect width="${width}" height="36" fill="${c.ground}"/>` +
      `<rect x="0.5" y="0.5" width="${width - 1}" height="35" fill="none" stroke="${c.rule}"/>` +
      `<rect x="4.5" y="4.5" width="${width - 9}" height="27" fill="none" stroke="${c.rule}"/>` +
      (c.flag
        ? `<rect x="${divide}" y="5" width="${width - 5 - divide}" height="26" fill="${FLAG}"/>`
        : "") +
      `<path d="M${divide + 0.5} 5v26" stroke="${c.rule}"/>` +
      mark("translate(11 7) scale(0.6875)", c.ground, c.cargo) +
      place(label, 39, 22.2, c.rule) +
      place(word, divide + 10.5, 22.6, c.word),
  );
}

const badges: Record<string, string> = {
  light: small({
    left: PAPER,
    right: INK,
    ground: PAPER,
    cargo: INK,
    label: INK,
    word: PAPER,
    outline: INK,
  }),
  dark: small({ left: DEEP, right: FLAG, ground: DEEP, cargo: PAPER, label: PAPER, word: DEEP }),
  flag: small({ left: INK, right: FLAG, ground: DEEP, cargo: PAPER, label: PAPER, word: DEEP }),
  "large-light": large({ ground: PAPER, rule: INK, cargo: INK, word: INK }),
  "large-dark": large({ ground: DEEP, rule: PAPER, cargo: PAPER, word: PAPER }),
  "large-flag": large({ ground: PAPER, rule: INK, cargo: INK, word: DEEP, flag: true }),
};

mkdirSync(OUT, { recursive: true });
for (const [name, body] of Object.entries(badges)) {
  writeFileSync(path.join(OUT, `deployed-on-gangway-${name}.svg`), body);
}
console.log(`${Object.keys(badges).length} badges written to ${path.relative(ROOT, OUT)}`);
