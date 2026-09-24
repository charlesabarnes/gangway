import {
  csvHeader,
  frontMatter,
  INLINE_RE,
  parseAttrs,
  pieces,
  scan,
  type Attrs,
  type Block,
} from "./grammar.ts";
import {
  ARTIFACT_ACCENTS,
  ARTIFACT_KINDS,
  ARTIFACT_THEMES,
  CHART_TYPES,
  CONTAINERS,
  DEVICES,
  FORMATS,
  FRONT_MATTER_KEYS,
  INLINE_DIRECTIVES,
  oneOf,
  SLIDE_LAYOUTS,
  TONES,
  type ArtifactAccent,
  type ArtifactKind,
  type ArtifactTheme,
} from "./vocab.ts";

export type LintIssue = { line: number; message: string };
export type ArtifactInfo = {
  kind: ArtifactKind;
  title: string;
  description: string | null;
  theme: ArtifactTheme;
  accent: ArtifactAccent;
};
export type LintResult = { info: ArtifactInfo | null; issues: LintIssue[] };
export type LintOptions = { has?: ((path: string) => boolean) | undefined };

type Ctx = { issues: LintIssue[]; opts: LintOptions; screens: Set<string>; links: LintIssue[] };

const inList = (list: readonly string[], v: string | undefined) =>
  v === undefined || list.includes(v);

function checkValue(
  c: Ctx,
  line: number,
  what: string,
  v: string | undefined,
  list: readonly string[],
) {
  if (!inList(list, v)) c.issues.push({ line, message: `${what}="${v}": one of ${oneOf(list)}` });
}

function percentValue(c: Ctx, line: number, a: Attrs) {
  const n = Number(a["value"]);
  if (a["format"] === "percent" && Number.isFinite(n) && Math.abs(n) > 1)
    c.issues.push({
      line,
      message: `value="${a["value"]}" with format=percent is ${n * 100}%; write ${n / 100} or "${n}%"`,
    });
}

function checkStat(c: Ctx, line: number, a: Attrs) {
  if (!a["label"]) c.issues.push({ line, message: "::stat needs label=" });
  if (a["value"] === undefined) c.issues.push({ line, message: "::stat needs value=" });
  checkValue(c, line, "format", a["format"], FORMATS);
  checkValue(c, line, "good", a["good"], ["up", "down"]);
  percentValue(c, line, a);
}

function checkChart(c: Ctx, b: Extract<Block, { type: "chart" }>) {
  const a = b.attrs;
  if (!b.closed) c.issues.push({ line: b.line, message: "this ```chart fence is never closed" });
  if (!a["type"])
    c.issues.push({
      line: b.line,
      message: `a chart needs a type first: \`\`\`chart ${oneOf(CHART_TYPES)} …`,
    });
  else checkValue(c, b.line, "chart type", a["type"], CHART_TYPES);
  checkValue(c, b.line, "format", a["format"], FORMATS);
  if (!a["x"] || !a["y"])
    c.issues.push({
      line: b.line,
      message: "a chart needs x= (the category column) and y= (one or more value columns)",
    });
  const inline = b.csv.some((l) => l.trim() !== "");
  if (a["src"]) {
    if (inline) c.issues.push({ line: b.line, message: "give the rows inline or src=, not both" });
    else if (c.opts.has && !c.opts.has(a["src"]))
      c.issues.push({ line: b.line, message: `src=${a["src"]} is not in the upload` });
    return;
  }
  if (!inline)
    return void c.issues.push({
      line: b.line,
      message: "the chart has no rows: put CSV inside the fence, or src=data/x.csv",
    });
  const head = csvHeader(b.csv);
  const want = [a["x"], ...(a["y"] ?? "").split(",")]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  const missing = want.filter((k) => !head.includes(k));
  if (missing.length)
    c.issues.push({
      line: b.line + 1,
      message: `the CSV header (${head.join(", ")}) has no column ${missing.join(", ")}`,
    });
}

function checkContainer(c: Ctx, b: Extract<Block, { type: "container" }>) {
  if (!(CONTAINERS as readonly string[]).includes(b.name))
    return void c.issues.push({
      line: b.line,
      message: `unknown block :::${b.name}; blocks are ${oneOf(CONTAINERS)}`,
    });
  if (!b.closed) c.issues.push({ line: b.line, message: `:::${b.name} is never closed with :::` });
  checkValue(c, b.line, "tone", b.attrs["tone"], TONES);
  const lines = b.raw
    .map((text, i) => ({ text, line: b.line + 1 + i }))
    .filter((l) => l.text.trim() !== "");
  if (b.name === "stats")
    for (const l of lines.filter((l) => l.text.split("|").length < 2))
      c.issues.push({ line: l.line, message: "a stats line is Label | value | change | note" });
  if (b.name === "facts")
    for (const l of lines.filter((l) => !l.text.includes(":")))
      c.issues.push({ line: l.line, message: "a facts line is Name: value" });
  if (b.name === "columns" && !b.raw.some((l) => l.trim() === "+++"))
    c.issues.push({ line: b.line, message: ":::columns needs a +++ line between the two columns" });
  if (b.name !== "stats" && b.name !== "facts") walk(c, b.body);
}

function checkText(c: Ctx, line: number, text: string) {
  for (const m of text.matchAll(INLINE_RE)) {
    const [whole, name = "", , raw] = m;
    if (!(INLINE_DIRECTIVES as readonly string[]).includes(name)) {
      if (raw !== undefined)
        c.issues.push({
          line,
          message: `unknown :${name}[…]; inline pieces are ${oneOf(INLINE_DIRECTIVES)}`,
        });
      continue;
    }
    const a = parseAttrs(raw);
    if (name === "flag") checkValue(c, line, "tone", a["tone"], TONES);
    if (name === "button" && a["go"]) c.links.push({ line, message: a["go"] });
    if (name === "select" && !a["options"])
      c.issues.push({ line, message: `${whole}: a select needs options="A,B"` });
  }
  for (const m of text.matchAll(/\]\(#([\w-]+)\)/g)) c.links.push({ line, message: m[1]! });
}

function walk(c: Ctx, blocks: Block[]) {
  for (const b of blocks) {
    if (b.type === "chart") checkChart(c, b);
    else if (b.type === "stat") checkStat(c, b.line, b.attrs);
    else if (b.type === "container") checkContainer(c, b);
    else if (b.type === "text") {
      if (/^:{3,}\s*$/.test(b.text))
        c.issues.push({ line: b.line, message: "a ::: with no block open" });
      else checkText(c, b.line, b.text);
    }
  }
}

function checkFrontMatter(c: Ctx, meta: Record<string, string>): ArtifactKind | null {
  const kind = meta["kind"];
  if (!kind || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    c.issues.push({ line: 1, message: `front matter needs kind: ${oneOf(ARTIFACT_KINDS)}` });
    return null;
  }
  const k = kind as ArtifactKind;
  if (!meta["title"]) c.issues.push({ line: 1, message: "front matter needs title:" });
  const unknown = Object.keys(meta).filter((key) => !FRONT_MATTER_KEYS[k].includes(key));
  if (unknown.length)
    c.issues.push({
      line: 1,
      message: `a ${k} has no ${unknown.join(", ")}; it takes ${FRONT_MATTER_KEYS[k].join(", ")}`,
    });
  checkValue(c, 1, "accent", meta["accent"], ARTIFACT_ACCENTS);
  checkValue(c, 1, "theme", meta["theme"], ARTIFACT_THEMES);
  checkValue(c, 1, "device", meta["device"], DEVICES);
  return k;
}

function checkPieces(c: Ctx, kind: ArtifactKind, body: string, offset: number) {
  for (const p of pieces(body, offset)) {
    if (kind === "deck") checkValue(c, p.line, "layout", p.head?.["layout"], SLIDE_LAYOUTS);
    if (kind === "prototype") {
      const id = p.head?.["id"];
      if (!id) c.issues.push({ line: p.line, message: 'start each screen with {#id title="…"}' });
      else if (c.screens.has(id))
        c.issues.push({ line: p.line, message: `two screens are called #${id}` });
      else c.screens.add(id);
      if (p.head?.["back"]) c.links.push({ line: p.line, message: p.head["back"] });
    }
    walk(c, scan(p.lines, p.first));
  }
}

export function lintMarkdown(src: string, opts: LintOptions = {}): LintResult {
  const c: Ctx = { issues: [], opts, screens: new Set(), links: [] };
  const { meta, body, offset } = frontMatter(src);
  if (!/^---\r?\n/.test(src))
    c.issues.push({ line: 1, message: "start with front matter: ---, kind: …, title: …, ---" });
  const kind = checkFrontMatter(c, meta);
  if (kind === "deck" || kind === "prototype") checkPieces(c, kind, body, offset);
  else walk(c, scan(body.split(/\r?\n/), offset + 1));
  if (kind === "prototype") {
    if (meta["start"]) c.links.push({ line: 1, message: meta["start"] });
    for (const l of c.links)
      if (!c.screens.has(l.message))
        c.issues.push({ line: l.line, message: `no screen has the id #${l.message}` });
  }
  c.issues.sort((a, b) => a.line - b.line);
  const info: ArtifactInfo | null = kind
    ? {
        kind,
        title: meta["title"] ?? "",
        description: meta["subtitle"] || null,
        theme: (meta["theme"] as ArtifactTheme | undefined) ?? "system",
        accent: (meta["accent"] as ArtifactAccent | undefined) ?? "flag",
      }
    : null;
  return { info, issues: c.issues.slice(0, 20) };
}

export const issueText = (file: string, issues: readonly LintIssue[]) =>
  issues.map((i) => `${file} line ${i.line}: ${i.message}`).join("; ");
