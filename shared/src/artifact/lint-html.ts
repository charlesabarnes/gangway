import { must } from "../must.ts";
import { parseFlow } from "./flow.ts";
import { csvHeader, parseAttrs } from "./grammar.ts";
import type { ArtifactInfo, LintIssue } from "./lint.ts";
import {
  ARTIFACT_ACCENTS,
  CHART_TYPES,
  ELEMENTS,
  FORMATS,
  oneOf,
  ROOT_TAG,
  SLIDE_LAYOUTS,
  TONES,
  type ArtifactAccent,
  ARTIFACT_KINDS,
  ARTIFACT_MODES,
  type ArtifactMode,
} from "./vocab.ts";

export const usesKit = (html: string) => /\/_gangway\/kit\.(js|css)/.test(html);

type Tag = { name: string; attrs: Record<string, string>; line: number; at: number; end: number };

// An opening tag, <gw-name attr attr="x" attr='x' attr=x>, built up from its attributes.
const ATTR_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s>"']+)`;
const ATTR = String.raw`\s+[^\s>="']+(?:=${ATTR_VALUE})?`;
const TAG = String.raw`<(gw-[\w-]+)((?:${ATTR})*)\s*\/?>`;

function tags(html: string): Tag[] {
  const out: Tag[] = [];
  for (const m of html.matchAll(new RegExp(TAG, "g"))) {
    const at = m.index;
    out.push({
      name: must(m[1], "a tag name"),
      attrs: parseAttrs(m[2] ?? ""),
      line: html.slice(0, at).split("\n").length,
      at,
      end: at + m[0].length,
    });
  }
  return out;
}

function checkChart(html: string, t: Tag, issues: LintIssue[]) {
  const a = t.attrs;
  const bad = (message: string) => issues.push({ line: t.line, message: `<gw-chart>: ${message}` });
  if (!(CHART_TYPES as readonly string[]).includes(a["type"] ?? "")) {
    bad(`type="${a["type"] ?? ""}": one of ${oneOf(CHART_TYPES)}`);
  }
  if (a["format"] && !(FORMATS as readonly string[]).includes(a["format"])) {
    bad(`format="${a["format"]}": one of ${oneOf(FORMATS)}`);
  }
  if (!a["x"] || !a["y"]) {
    return bad("needs x= and y=");
  }
  if (a["src"]) {
    return;
  }
  const close = html.indexOf("</gw-chart>", t.end);
  const csv = html.slice(t.end, close === -1 ? undefined : close).split("\n");
  const head = csvHeader(csv);
  const missing = [a["x"], ...a["y"].split(",")]
    .map((s) => s.trim())
    .filter((k) => !head.includes(k));
  if (missing.length) {
    bad(`the CSV header (${head.join(", ")}) has no column ${missing.join(", ")}`);
  }
}

function checkFlow(html: string, t: Tag, issues: LintIssue[]) {
  const close = html.indexOf("</gw-flow>", t.end);
  const src = html.slice(t.end, close === -1 ? undefined : close);
  const first = t.line + (src.startsWith("\n") ? 1 : 0);
  const g = parseFlow(src.replace(/^\n/, ""), first, t.attrs["direction"]);
  for (const i of g.issues) {
    issues.push({ line: i.line, message: `<gw-flow>: ${i.message}` });
  }
}

function checkTag(html: string, t: Tag, issues: LintIssue[]) {
  const a = t.attrs;
  if (!(ELEMENTS as readonly string[]).includes(t.name)) {
    return void issues.push({ line: t.line, message: `unknown element <${t.name}>` });
  }
  if (t.name === "gw-chart") {
    checkChart(html, t, issues);
  }
  if (t.name === "gw-flow") {
    checkFlow(html, t, issues);
  }
  if (a["tone"] && !(TONES as readonly string[]).includes(a["tone"])) {
    issues.push({
      line: t.line,
      message: `<${t.name}> tone="${a["tone"]}": one of ${oneOf(TONES)}`,
    });
  }
  if (
    t.name === "gw-slide" &&
    a["layout"] &&
    !(SLIDE_LAYOUTS as readonly string[]).includes(a["layout"])
  ) {
    issues.push({
      line: t.line,
      message: `<gw-slide> layout="${a["layout"]}": one of ${oneOf(SLIDE_LAYOUTS)}`,
    });
  }
  const n = Number(a["value"]);
  if (t.name === "gw-stat" && a["format"] === "percent" && Number.isFinite(n) && Math.abs(n) > 1) {
    issues.push({
      line: t.line,
      message: `<gw-stat> value="${a["value"]}" with format="percent" is ${n * 100}%; write ${n / 100} or "${n}%"`,
    });
  }
}

export function lintHtml(html: string): { info: ArtifactInfo | null; issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  const all = tags(html);
  for (const t of all) {
    checkTag(html, t, issues);
  }
  const rootTags = ARTIFACT_KINDS.map((k) => ROOT_TAG[k]);
  const roots = all.filter((t) => rootTags.includes(t.name));
  if (roots.length !== 1) {
    issues.push({
      line: roots[1]?.line ?? 1,
      message: `one root element: ${rootTags.join(", ")} (found ${roots.length})`,
    });
  }
  const info = roots[0] ? infoOf(html, roots[0]) : null;
  return { info, issues: issues.toSorted((a, b) => a.line - b.line).slice(0, 20) };
}

const modeOf = (m: string | undefined): ArtifactMode =>
  (ARTIFACT_MODES as readonly string[]).includes(m ?? "") ? (m as ArtifactMode) : "system";

function infoOf(html: string, root: { name: string; attrs: Record<string, string> }): ArtifactInfo {
  const kind = must(
    ARTIFACT_KINDS.find((k) => ROOT_TAG[k] === root.name),
    `a kind for <${root.name}>`,
  );
  const accent = /data-accent="([\w-]+)"/.exec(html)?.[1] ?? root.attrs["accent"] ?? "flag";
  return {
    kind,
    title: root.attrs["title"] ?? /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "",
    description: root.attrs["subtitle"] === "" ? null : (root.attrs["subtitle"] ?? null),
    mode: modeOf(root.attrs["mode"] ?? root.attrs["theme"]),
    theme: null,
    css: null,
    accent: ((ARTIFACT_ACCENTS as readonly string[]).includes(accent)
      ? accent
      : "flag") as ArtifactAccent,
  };
}
