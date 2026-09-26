import type { ArtifactAccent, ArtifactKind, ArtifactTheme } from "../vocab.ts";

export type OptionValue = number | string | boolean;
export type TemplateOption =
  | { key: string; label: string; kind: "number"; min: number; max: number; default: number }
  | {
      key: string;
      label: string;
      kind: "choice";
      choices: { value: string; label: string }[];
      default: string;
    }
  | { key: string; label: string; kind: "boolean"; default: boolean };

export type TemplateSettings = {
  title: string;
  subtitle: string;
  theme: ArtifactTheme;
  accent: ArtifactAccent;
  opts: Record<string, OptionValue>;
};

export type Built = { markdown: string; data?: Record<string, string> };

export type ArtifactTemplate = {
  id: string;
  kind: ArtifactKind;
  name: string;
  description: string;
  title: string;
  subtitle: string;
  options: TemplateOption[];
  build: (s: TemplateSettings) => Built;
};

type AttrMap = Record<string, string | number | boolean | undefined>;

export const num = (s: TemplateSettings, key: string): number => Number(s.opts[key]);
export const str = (s: TemplateSettings, key: string): string => String(s.opts[key]);
export const flag = (s: TemplateSettings, key: string): boolean => s.opts[key] === true;

export function choice(key: string, label: string, def: string, values: [string, string][]) {
  return {
    key,
    label,
    kind: "choice" as const,
    default: def,
    choices: values.map(([value, l]) => ({ value, label: l })),
  };
}

export function front(
  s: TemplateSettings,
  kind: ArtifactKind,
  extra: Record<string, string> = {},
): string {
  const lines = [
    `kind: ${kind}`,
    `title: ${s.title}`,
    ...(s.subtitle ? [`subtitle: ${s.subtitle}`] : []),
    `accent: ${s.accent}`,
    ...(s.theme !== "system" ? [`theme: ${s.theme}`] : []),
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
  ];
  return `---\n${lines.join("\n")}\n---`;
}

const quote = (v: string) => (/[\s"]/.test(v) || v === "" ? `"${v.replace(/"/g, "'")}"` : v);
export const attrs = (a: AttrMap) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}=${quote(String(v))}`))
    .join(" ");

export function chart(type: string, a: AttrMap, rows?: (string | number)[][]): string {
  const body = rows ? `\n${rows.map((r) => r.join(",")).join("\n")}` : "";
  return `\`\`\`chart ${type} ${attrs(a)}${body}\n\`\`\``;
}

/** A ::: block; one that holds other blocks needs a longer fence (colons = 4, 5, …). */
export const block = (name: string, a: AttrMap, inner: string, colons = 3) => {
  const fence = ":".repeat(colons);
  return `${fence} ${name}${Object.keys(a).length ? ` ${attrs(a)}` : ""}\n${inner}\n${fence}`;
};

export const stat = (a: AttrMap) => `::stat{${attrs(a)}}`;

export function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10_000) / 10_000;
  };
}

export function series(
  seed: number,
  n: number,
  base: number,
  spread: number,
  growth = 0,
): number[] {
  const r = rng(seed);
  const step = base >= 100 ? 1 : base >= 1 ? 0.1 : 0.0001;
  return Array.from({ length: n }, (_, i) => {
    const v = Math.max(0, base + (r() - 0.5) * spread + i * growth);
    return Math.round(Math.round(v / step) * step * 10_000) / 10_000;
  });
}

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function csv(rows: Record<string, string | number>[]): string {
  const head = Object.keys(rows[0] ?? {});
  return (
    [head.join(","), ...rows.map((r) => head.map((h) => String(r[h])).join(","))].join("\n") + "\n"
  );
}

export function days(n: number, end = "2026-09-30"): string[] {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    new Date(last - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Joins the parts of a markdown file, dropping the ones an option turned off. */
export const md = (...parts: (string | false | undefined)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p !== "").join("\n\n") + "\n";

/** Joins deck slides or prototype screens. */
export const slides = (...parts: (string | false | undefined)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p !== "").join("\n\n---\n\n");
