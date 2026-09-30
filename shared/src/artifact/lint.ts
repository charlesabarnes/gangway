import { must } from "../must.ts";
import {
  csvHeader,
  frontMatter,
  INLINE_RE,
  parseAttrs,
  pieces,
  scan,
  type Attrs,
  type Block,
  type Piece,
} from "./grammar.ts";
import { FLOW_DIRECTIONS, parseFlow } from "./flow.ts";
import { CANVAS_LAYOUTS, FRAME_STYLES } from "./canvas.ts";
import {
  ARROW_LINE,
  ARTIFACT_ACCENTS,
  ARTIFACT_KINDS,
  ARTIFACT_MODES,
  CHART_TYPES,
  CONTAINERS,
  DECK_LOOKS,
  DOC_LAYOUTS,
  FORMATS,
  FRONT_MATTER_KEYS,
  HOUSE_THEME,
  INLINE_DIRECTIVES,
  oneOf,
  RETIRED_KINDS,
  SLIDE_LAYOUTS,
  THEME_ID,
  TONES,
  type ArtifactAccent,
  type ArtifactKind,
  type ArtifactMode,
} from "./vocab.ts";

export type LintIssue = { line: number; message: string };
export type ArtifactInfo = {
  kind: ArtifactKind;
  title: string;
  description: string | null;
  mode: ArtifactMode;
  /** A theme by id; null follows the server's default theme. */
  theme: string | null;
  accent: ArtifactAccent;
  /** A stylesheet from the upload, linked after the theme. */
  css: string | null;
};
export type LintResult = { info: ArtifactInfo | null; issues: LintIssue[] };
export type LintOptions = {
  has?: ((path: string) => boolean) | undefined;
  /** The theme ids this server has, when it knows them; any well-formed id passes without. */
  themes?: readonly string[] | undefined;
};

type Ctx = { issues: LintIssue[]; opts: LintOptions };

const RETIRED_HINT: Record<string, string> = {
  dashboard: "use kind: document; stats and charts work in a document",
  prototype: "use kind: deck for a walkthrough, or write your own index.html",
};

const inList = (list: readonly string[], v: string | undefined) =>
  v === undefined || list.includes(v);

function checkValue(
  c: Ctx,
  line: number,
  [what, v]: [attr: string, value: string | undefined],
  list: readonly string[],
) {
  if (!inList(list, v)) {
    c.issues.push({ line, message: `${what}="${v}": one of ${oneOf(list)}` });
  }
}

function percentValue(c: Ctx, line: number, a: Attrs) {
  const n = Number(a["value"]);
  if (a["format"] === "percent" && Number.isFinite(n) && Math.abs(n) > 1) {
    c.issues.push({
      line,
      message: `value="${a["value"]}" with format=percent is ${n * 100}%; write ${n / 100} or "${n}%"`,
    });
  }
}

function checkStat(c: Ctx, line: number, a: Attrs) {
  if (!a["label"]) {
    c.issues.push({ line, message: "::stat needs label=" });
  }
  if (a["value"] === undefined) {
    c.issues.push({ line, message: "::stat needs value=" });
  }
  checkValue(c, line, ["format", a["format"]], FORMATS);
  checkValue(c, line, ["good", a["good"]], ["up", "down"]);
  percentValue(c, line, a);
}

function checkChart(c: Ctx, b: Extract<Block, { type: "chart" }>) {
  const a = b.attrs;
  if (!b.closed) {
    c.issues.push({ line: b.line, message: "this ```chart fence is never closed" });
  }
  if (!a["type"]) {
    c.issues.push({
      line: b.line,
      message: `a chart needs a type first: \`\`\`chart ${oneOf(CHART_TYPES)} …`,
    });
  } else {
    checkValue(c, b.line, ["chart type", a["type"]], CHART_TYPES);
  }
  checkValue(c, b.line, ["format", a["format"]], FORMATS);
  if (!a["x"] || !a["y"]) {
    c.issues.push({
      line: b.line,
      message: "a chart needs x= (the category column) and y= (one or more value columns)",
    });
  }
  const inline = b.csv.some((l) => l.trim() !== "");
  if (a["src"]) {
    if (inline) {
      c.issues.push({ line: b.line, message: "give the rows inline or src=, not both" });
    } else if (c.opts.has && !c.opts.has(a["src"])) {
      c.issues.push({ line: b.line, message: `src=${a["src"]} is not in the upload` });
    }
    return;
  }
  if (!inline) {
    c.issues.push({
      line: b.line,
      message: "the chart has no rows: put CSV inside the fence, or src=data/x.csv",
    });
    return;
  }
  const head = csvHeader(b.csv);
  const want = [a["x"], ...(a["y"] ?? "").split(",")]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  const missing = want.filter((k) => !head.includes(k));
  if (missing.length) {
    c.issues.push({
      line: b.line + 1,
      message: `the CSV header (${head.join(", ")}) has no column ${missing.join(", ")}`,
    });
  }
}

function checkFlow(c: Ctx, b: Extract<Block, { type: "flow" }>) {
  if (!b.closed) {
    c.issues.push({ line: b.line, message: "this ```flow fence is never closed" });
  }
  const dir = b.attrs["direction"];
  checkValue(c, b.line, ["direction", dir?.toUpperCase()], FLOW_DIRECTIONS);
  c.issues.push(...parseFlow(b.src.join("\n"), b.line + 1).issues);
}

function checkContainer(c: Ctx, b: Extract<Block, { type: "container" }>) {
  if (!(CONTAINERS as readonly string[]).includes(b.name)) {
    c.issues.push({
      line: b.line,
      message: `unknown block :::${b.name}; blocks are ${oneOf(CONTAINERS)}`,
    });
    return;
  }
  if (!b.closed) {
    c.issues.push({ line: b.line, message: `:::${b.name} is never closed with :::` });
  }
  checkValue(c, b.line, ["tone", b.attrs["tone"]], TONES);
  const lines = b.raw
    .map((text, i) => ({ text, line: b.line + 1 + i }))
    .filter((l) => l.text.trim() !== "");
  if (b.name === "stats") {
    for (const l of lines.filter((l) => l.text.split("|").length < 2)) {
      c.issues.push({ line: l.line, message: "a stats line is Label | value | change | note" });
    }
  }
  if (b.name === "facts") {
    for (const l of lines.filter((l) => !/:\s/.test(l.text))) {
      c.issues.push({ line: l.line, message: "a facts line is Name: value" });
    }
  }
  if (b.name === "columns" && !b.raw.some((l) => l.trim() === "+++")) {
    c.issues.push({ line: b.line, message: ":::columns needs a +++ line between the two columns" });
  }
  if (b.name !== "stats" && b.name !== "facts") {
    walk(c, b.body);
  }
}

type Directive = { line: number; whole: string; text: string; a: Attrs };

function checkSteps(c: Ctx, { line, whole, text, a }: Directive) {
  const n = text.split(",").filter((t) => t.trim()).length;
  const at = Number(a["at"] ?? 1);
  if (n < 2) {
    c.issues.push({ line, message: `${whole}: list the steps, e.g. :steps[Cart,Pay,Done]` });
  } else if (!Number.isInteger(at) || at < 1 || at > n) {
    c.issues.push({ line, message: `${whole}: at= is the current step, 1 to ${n}` });
  }
}

function checkImage(c: Ctx, { line, whole, a }: Directive) {
  if (a["ratio"] && !/^\d+:\d+$/.test(a["ratio"])) {
    c.issues.push({ line, message: `${whole}: ratio= is width:height, e.g. 16:9` });
  }
  const src = a["src"];
  if (src && !/^https?:\/\//.test(src) && c.opts.has && !c.opts.has(src)) {
    c.issues.push({ line, message: `src=${src} is not in the upload` });
  }
}

function checkText(c: Ctx, line: number, text: string) {
  for (const m of text.matchAll(INLINE_RE)) {
    const [whole, name = "", text = "", raw] = m;
    if (!(INLINE_DIRECTIVES as readonly string[]).includes(name)) {
      if (raw !== undefined) {
        c.issues.push({
          line,
          message: `unknown :${name}[…]; inline pieces are ${oneOf(INLINE_DIRECTIVES)}`,
        });
      }
      continue;
    }
    const a = parseAttrs(raw);
    const d = { line, whole, text, a };
    if (name === "flag") {
      checkValue(c, line, ["tone", a["tone"]], TONES);
    }
    if (name === "steps") {
      checkSteps(c, d);
    }
    if (name === "image") {
      checkImage(c, d);
    }
  }
}

function walk(c: Ctx, blocks: Block[]) {
  for (const b of blocks) {
    if (b.type === "chart") {
      checkChart(c, b);
    } else if (b.type === "flow") {
      checkFlow(c, b);
    } else if (b.type === "stat") {
      checkStat(c, b.line, b.attrs);
    } else if (b.type === "container") {
      checkContainer(c, b);
    } else if (b.type === "text") {
      if (/^:{3,}\s*$/.test(b.text)) {
        c.issues.push({ line: b.line, message: "a ::: with no block open" });
      } else {
        checkText(c, b.line, b.text);
      }
    }
  }
}

function checkTheme(c: Ctx, meta: Record<string, string>) {
  const theme = meta["theme"];
  if (theme === undefined || (ARTIFACT_MODES as readonly string[]).includes(theme)) {
    return;
  }
  const known = c.opts.themes;
  if (!THEME_ID.test(theme)) {
    c.issues.push({ line: 1, message: `theme: "${theme}" is not a theme id (a-z, 0-9, -)` });
  } else if (known && theme !== HOUSE_THEME && !known.includes(theme)) {
    c.issues.push({
      line: 1,
      message: `theme: no theme called "${theme}"; this server has ${oneOf([HOUSE_THEME, ...known])}`,
    });
  }
}

function checkCss(c: Ctx, css: string | undefined) {
  if (css === undefined) {
    return;
  }
  if (!/^[\w./-]+\.css$/.test(css) || css.includes("..")) {
    c.issues.push({ line: 1, message: `css: "${css}" is a path to a .css file in the upload` });
  } else if (c.opts.has && !c.opts.has(css.replace(/^\//, ""))) {
    c.issues.push({ line: 1, message: `css: ${css} is not in the upload` });
  }
}

function checkFrontMatter(c: Ctx, meta: Record<string, string>): ArtifactKind | null {
  const kind = meta["kind"];
  if (kind && (RETIRED_KINDS as readonly string[]).includes(kind)) {
    c.issues.push({ line: 1, message: `kind: ${kind} is retired; ${RETIRED_HINT[kind]}` });
    return null;
  }
  if (!kind || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    c.issues.push({ line: 1, message: `front matter needs kind: ${oneOf(ARTIFACT_KINDS)}` });
    return null;
  }
  const k = kind as ArtifactKind;
  if (!meta["title"]) {
    c.issues.push({ line: 1, message: "front matter needs title:" });
  }
  const unknown = Object.keys(meta).filter((key) => !FRONT_MATTER_KEYS[k].includes(key));
  if (unknown.length) {
    c.issues.push({
      line: 1,
      message: `a ${k} has no ${unknown.join(", ")}; it takes ${FRONT_MATTER_KEYS[k].join(", ")}`,
    });
  }
  checkValue(c, 1, ["accent", meta["accent"]], ARTIFACT_ACCENTS);
  checkValue(c, 1, ["mode", meta["mode"]], ARTIFACT_MODES);
  if (k === "document") {
    checkValue(c, 1, ["layout", meta["layout"]], DOC_LAYOUTS);
  }
  if (k === "deck") {
    checkValue(c, 1, ["look", meta["look"]], DECK_LOOKS);
  }
  if (k === "canvas") {
    checkValue(c, 1, ["layout", meta["layout"]], CANVAS_LAYOUTS);
    for (const key of ["columns", "gap"]) {
      if (meta[key] !== undefined && !/^\d{1,4}$/.test(meta[key])) {
        c.issues.push({ line: 1, message: `${key}: a whole number, not "${meta[key]}"` });
      }
    }
  }
  checkTheme(c, meta);
  checkCss(c, meta["css"]);
  return k;
}

function checkSlides(c: Ctx, body: string, offset: number) {
  for (const p of pieces(body, offset)) {
    checkValue(c, p.line, ["layout", p.head?.["layout"]], SLIDE_LAYOUTS);
    walk(c, scan(p.lines, p.first));
  }
}

/** A frame's {#id x= y= w= h=} head: a unique id, and whole-pixel positions given in pairs. */
function checkFrameHead(c: Ctx, p: Piece, ids: Set<string>) {
  const id = p.head?.["id"];
  if (!id) {
    c.issues.push({ line: p.line, message: 'start each frame with {#id title="…"}' });
  } else if (ids.has(id)) {
    c.issues.push({ line: p.line, message: `two frames are called #${id}` });
  } else {
    ids.add(id);
  }
  for (const key of ["x", "y", "w", "h"]) {
    const v = p.head?.[key];
    if (v !== undefined && !/^-?\d{1,5}$/.test(v)) {
      c.issues.push({ line: p.line, message: `${key}=${v}: a whole number of pixels` });
    }
  }
  if (p.head && (p.head["x"] === undefined) !== (p.head["y"] === undefined)) {
    c.issues.push({ line: p.line, message: "give x and y together, or neither" });
  }
}

function checkFrames(c: Ctx, body: string, offset: number) {
  const ids = new Set<string>();
  const arrows: LintIssue[] = [];
  for (const p of pieces(body, offset)) {
    checkFrameHead(c, p, ids);
    checkValue(c, p.line, ["frame", p.head?.["frame"]], FRAME_STYLES);
    const rest: string[] = [];
    p.lines.forEach((l, i) => {
      const m = ARROW_LINE.exec(l.trim());
      if (m) {
        arrows.push({ line: p.first + i, message: must(m[1], "an arrow's text") });
      } else {
        rest.push(l);
      }
    });
    walk(c, scan(rest, p.first));
  }
  for (const a of arrows) {
    if (!ids.has(a.message)) {
      c.issues.push({
        line: a.line,
        message: `-> ${a.message}: no frame has the id #${a.message}`,
      });
    }
  }
}

/** The mode, from `mode:` or, as before there was one, `theme: light | dark | system`. */
function modeOf(meta: Record<string, string>): ArtifactMode {
  const m = meta["mode"] ?? meta["theme"];
  return (ARTIFACT_MODES as readonly string[]).includes(m ?? "") ? (m as ArtifactMode) : "system";
}

function themeOf(meta: Record<string, string>): string | null {
  const t = meta["theme"];
  return t && !(ARTIFACT_MODES as readonly string[]).includes(t) ? t : null;
}

export function lintMarkdown(src: string, opts: LintOptions = {}): LintResult {
  const c: Ctx = { issues: [], opts };
  const { meta, body, offset } = frontMatter(src);
  if (!/^---\r?\n/.test(src)) {
    c.issues.push({ line: 1, message: "start with front matter: ---, kind: …, title: …, ---" });
  }
  const kind = checkFrontMatter(c, meta);
  if (kind === "deck") {
    checkSlides(c, body, offset);
  } else if (kind === "canvas") {
    checkFrames(c, body, offset);
  } else if (kind) {
    walk(c, scan(body.split(/\r?\n/), offset + 1));
  }
  c.issues.sort((a, b) => a.line - b.line);
  const info: ArtifactInfo | null = kind
    ? {
        kind,
        title: meta["title"] ?? "",
        description: meta["subtitle"] === "" ? null : (meta["subtitle"] ?? null),
        mode: modeOf(meta),
        theme: themeOf(meta),
        accent: (meta["accent"] as ArtifactAccent | undefined) ?? "flag",
        css: meta["css"]?.replace(/^\//, "") ?? null,
      }
    : null;
  return { info, issues: c.issues.slice(0, 20) };
}

export const issueText = (file: string, issues: readonly LintIssue[]) =>
  issues.map((i) => `${file} line ${i.line}: ${i.message}`).join("; ");
