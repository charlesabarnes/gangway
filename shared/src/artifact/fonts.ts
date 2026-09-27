// The fonts a theme may pick. Each is a system stack or a face the kit serves itself from
// /_gangway/fonts; render/build.ts copies the files and writes their @font-face rules from this
// list, and a browser fetches a face only when a page uses it.

export type ThemeFontSlot = "serif" | "sans" | "mono" | "display";

export type KitFont = {
  /** What the editor calls it. */
  label: string;
  /** The CSS font-family value. */
  stack: string;
  /** A face the kit serves: the @fontsource package, the file prefix and the cuts it ships. */
  face?: { family: string; pkg: string; file: string; weights: number[]; italic?: number[] };
};

const W4 = [400, 500, 600, 700];

export const THEME_FONT_CHOICES = {
  serif: {
    // IBM Plex Serif is the house face; kit.css declares it by hand.
    "plex-serif": { label: "IBM Plex Serif", stack: '"IBM Plex Serif", Georgia, serif' },
    "source-serif": {
      label: "Source Serif 4",
      stack: '"Source Serif 4", Georgia, serif',
      face: {
        family: "Source Serif 4",
        pkg: "source-serif-4",
        file: "source-serif",
        weights: W4,
        italic: [400],
      },
    },
    merriweather: {
      label: "Merriweather",
      stack: "Merriweather, Georgia, serif",
      face: {
        family: "Merriweather",
        pkg: "merriweather",
        file: "merriweather",
        weights: W4,
        italic: [400],
      },
    },
    lora: {
      label: "Lora",
      stack: "Lora, Georgia, serif",
      face: { family: "Lora", pkg: "lora", file: "lora", weights: W4, italic: [400] },
    },
    fraunces: {
      label: "Fraunces",
      stack: "Fraunces, Georgia, serif",
      face: { family: "Fraunces", pkg: "fraunces", file: "fraunces", weights: W4, italic: [400] },
    },
    "libre-baskerville": {
      label: "Libre Baskerville",
      stack: '"Libre Baskerville", Georgia, serif',
      face: {
        family: "Libre Baskerville",
        pkg: "libre-baskerville",
        file: "libre-baskerville",
        weights: W4,
        italic: [400],
      },
    },
    georgia: { label: "Georgia", stack: 'Georgia, "Times New Roman", serif' },
    "system-serif": { label: "System serif", stack: 'ui-serif, "New York", Georgia, serif' },
  },
  sans: {
    "plex-sans-condensed": {
      label: "IBM Plex Sans Condensed",
      stack: '"IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif',
    },
    "plex-sans": {
      label: "IBM Plex Sans",
      stack: '"IBM Plex Sans", system-ui, sans-serif',
      face: { family: "IBM Plex Sans", pkg: "ibm-plex-sans", file: "plex-sans", weights: W4 },
    },
    inter: {
      label: "Inter",
      stack: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
      face: { family: "Inter", pkg: "inter", file: "inter", weights: W4 },
    },
    "source-sans": {
      label: "Source Sans 3",
      stack: '"Source Sans 3", system-ui, sans-serif',
      face: { family: "Source Sans 3", pkg: "source-sans-3", file: "source-sans", weights: W4 },
    },
    manrope: {
      label: "Manrope",
      stack: "Manrope, system-ui, sans-serif",
      face: { family: "Manrope", pkg: "manrope", file: "manrope", weights: W4 },
    },
    "dm-sans": {
      label: "DM Sans",
      stack: '"DM Sans", system-ui, sans-serif',
      face: { family: "DM Sans", pkg: "dm-sans", file: "dm-sans", weights: W4 },
    },
    "space-grotesk": {
      label: "Space Grotesk",
      stack: '"Space Grotesk", system-ui, sans-serif',
      face: { family: "Space Grotesk", pkg: "space-grotesk", file: "space-grotesk", weights: W4 },
    },
    "system-sans": {
      label: "System sans",
      stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    },
  },
  mono: {
    "plex-mono": {
      label: "IBM Plex Mono",
      stack: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    },
    "jetbrains-mono": {
      label: "JetBrains Mono",
      stack: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      face: {
        family: "JetBrains Mono",
        pkg: "jetbrains-mono",
        file: "jetbrains-mono",
        weights: [400, 600],
      },
    },
    "fira-code": {
      label: "Fira Code",
      stack: '"Fira Code", ui-monospace, Menlo, monospace',
      face: { family: "Fira Code", pkg: "fira-code", file: "fira-code", weights: [400, 600] },
    },
    "source-code-pro": {
      label: "Source Code Pro",
      stack: '"Source Code Pro", ui-monospace, Menlo, monospace',
      face: {
        family: "Source Code Pro",
        pkg: "source-code-pro",
        file: "source-code-pro",
        weights: [400, 600],
      },
    },
    "system-mono": {
      label: "System mono",
      stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    },
  },
  // For titles only, picked with titles: display.
  display: {
    "playfair-display": {
      label: "Playfair Display",
      stack: '"Playfair Display", Georgia, serif',
      face: {
        family: "Playfair Display",
        pkg: "playfair-display",
        file: "playfair",
        weights: W4,
        italic: [400],
      },
    },
    fraunces: { label: "Fraunces", stack: "Fraunces, Georgia, serif" },
    "space-grotesk": { label: "Space Grotesk", stack: '"Space Grotesk", system-ui, sans-serif' },
    caveat: {
      label: "Caveat (hand)",
      stack: 'Caveat, "Comic Sans MS", cursive',
      face: { family: "Caveat", pkg: "caveat", file: "caveat", weights: [400, 700] },
    },
    kalam: {
      label: "Kalam (hand)",
      stack: 'Kalam, "Comic Sans MS", cursive',
      face: { family: "Kalam", pkg: "kalam", file: "hand", weights: [400, 700] },
    },
  },
} satisfies Record<ThemeFontSlot, Record<string, KitFont>>;

/** Every face the kit serves beyond Plex, once each. */
export function kitFaces(): NonNullable<KitFont["face"]>[] {
  const seen = new Map<string, NonNullable<KitFont["face"]>>();
  for (const slot of Object.values(THEME_FONT_CHOICES))
    for (const f of Object.values(slot) as KitFont[]) if (f.face) seen.set(f.face.file, f.face);
  return [...seen.values()];
}

/** The @font-face rules for kitFaces(); `base` is where the files are, relative to kit.css by default. */
export function kitFaceCss(base = "fonts/"): string {
  const rules: string[] = [];
  for (const f of kitFaces()) {
    const rule = (w: number, italic: boolean) =>
      `@font-face{font-family:"${f.family}";font-weight:${w};${italic ? "font-style:italic;" : ""}font-display:swap;src:url(${base}${f.file}-${w}${italic ? "-italic" : ""}.woff2) format("woff2")}`;
    for (const w of f.weights) rules.push(rule(w, false));
    for (const w of f.italic ?? []) rules.push(rule(w, true));
  }
  return `${rules.join("\n")}\n`;
}
