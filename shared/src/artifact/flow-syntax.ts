/** The pieces of a flowchart line: node ids with their shapes, and the arrows between them. */
import { must } from "../must.ts";
import type { FlowEdge, FlowEdgeStyle, FlowShape } from "./flow.ts";

const ID = /^[\p{L}\p{N}_]+/u;
const SHAPES: [open: string, close: string, shape: FlowShape][] = [
  ["([", "])", "stadium"],
  ["[(", ")]", "cylinder"],
  ["((", "))", "circle"],
  ["{{", "}}", "diamond"],
  ["[/", "/]", "box"],
  ["[\\", "\\]", "box"],
  ["[", "]", "box"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "box"],
];

type EdgeMatch = {
  len: number;
  id: string | null;
  label: string;
  style: FlowEdgeStyle;
  arrow: FlowEdge["arrow"];
};

type Hit = { len: number; label: string };

const byRegex =
  (re: RegExp) =>
  (s: string): Hit | null => {
    const m = re.exec(s);
    return m ? { len: m[0].length, label: m[1] ?? "" } : null;
  };

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const LINE_END = /[\n\r\u2028\u2029]/;

function runOf(s: string, i: number, c: string): number {
  let j = i;
  while (s[j] === c) {
    j++;
  }
  return j - i;
}

function spacedClose(s: string, i: number, close: (s: string, i: number) => number): number {
  let j = i;
  while (isSpace(s[j])) {
    j++;
  }
  return j === i ? -1 : close(s, j);
}

/** "-- text -->", matched as /^open\s+(.+?)\s+close/ would be, without its backtracking. */
function labelled(
  open: string,
  close: (s: string, i: number) => number,
): (s: string) => Hit | null {
  return (s) => {
    if (!s.startsWith(open)) {
      return null;
    }
    let start = open.length;
    while (isSpace(s[start])) {
      start++;
    }
    if (start === open.length) {
      return null;
    }
    for (let e = start + 1; e <= s.length && !LINE_END.test(s.charAt(e - 1)); e++) {
      const end = spacedClose(s, e, close);
      if (end !== -1) {
        return { len: end, label: s.slice(start, e) };
      }
    }
    // No label ends in an arrow; the regex then gave some spaces back to make a blank label,
    // which it can when three or more spaces lead up to the arrow.
    const end = close(s, start);
    for (let p = start - 2; p > open.length && end !== -1; p--) {
      if (!LINE_END.test(s.charAt(p))) {
        return { len: end, label: s.charAt(p) };
      }
    }
    return null;
  };
}

function solidClose(s: string, i: number): number {
  const j = i + runOf(s, i, "-");
  if (j - i < 2) {
    return -1;
  }
  if (s[j] === ">") {
    return j + 1;
  }
  return (s[j] === "x" || s[j] === "o") && isSpace(s[j + 1]) ? j + 1 : -1;
}

function dottedClose(s: string, i: number): number {
  const j = i + runOf(s, i, ".");
  return j > i && s.startsWith("->", j) ? j + 2 : -1;
}

function thickClose(s: string, i: number): number {
  const j = i + runOf(s, i, "=");
  return j - i >= 2 && s[j] === ">" ? j + 1 : -1;
}

// Longest forms first: "-- text -->" before "--", "-.->" before "-.-".
const EDGES: [(s: string) => Hit | null, FlowEdgeStyle, FlowEdge["arrow"]][] = [
  [byRegex(/^<-{2,}>/), "solid", "both"],
  [byRegex(/^<={2,}>/), "thick", "both"],
  [byRegex(/^<-\.+->/), "dotted", "both"],
  [labelled("--", solidClose), "solid", "end"],
  [labelled("-.", dottedClose), "dotted", "end"],
  [labelled("==", thickClose), "thick", "end"],
  [byRegex(/^-{2,}(?:>|[xo](?=\s))/), "solid", "end"],
  [byRegex(/^-\.+->/), "dotted", "end"],
  [byRegex(/^={2,}>/), "thick", "end"],
  [byRegex(/^-{3,}/), "solid", "none"],
  [byRegex(/^-\.+-/), "dotted", "none"],
  [byRegex(/^={3,}/), "thick", "none"],
];

export function edgeAt(text: string): EdgeMatch | null {
  const named = /^([\p{L}\p{N}_]+)@(?=[-=<.])/u.exec(text);
  const s = named ? text.slice(named[0].length) : text;
  for (const [match, style, arrow] of EDGES) {
    const hit = match(s);
    if (!hit) {
      continue;
    }
    let len = hit.len + (named?.[0].length ?? 0);
    let label = hit.label;
    const pipe = /^\s*\|([^|]*)\|/.exec(text.slice(len));
    if (pipe) {
      label = must(pipe[1], "a pipe label");
      len += pipe[0].length;
    }
    return { len, id: named?.[1] ?? null, label: unquote(label.trim()), style, arrow };
  }
  return null;
}

/** Drops a `%%` comment: from the first %% with no line break after it, as /%%.*$/ did. */
export function uncomment(raw: string): string {
  const from = Math.max(...["\n", "\r", "\u2028", "\u2029"].map((c) => raw.lastIndexOf(c))) + 1;
  const at = raw.indexOf("%%", from);
  return at === -1 ? raw : raw.slice(0, at);
}

/**
 * `class a,b tone`: its ids and its tone, split as /^class\s+([\p{L}\p{N}_,\s]+?)\s+([\w-]+)$/u
 * splits them, without that regex's backtracking.
 */
export function classLine(s: string): [ids: string, tone: string] | null {
  const head = /^class\s+/.exec(s);
  if (!head) {
    return null;
  }
  let tone = s.length;
  while (tone > 0 && /[\w-]/.test(s.charAt(tone - 1))) {
    tone--;
  }
  let gap = tone;
  while (gap > 0 && isSpace(s.charAt(gap - 1))) {
    gap--;
  }
  if (tone === s.length || gap === tone) {
    return null;
  }
  const start = head[0].length;
  if (gap > start) {
    const ids = s.slice(start, gap);
    return /^[\p{L}\p{N}_,\s]+$/u.test(ids) ? [ids, s.slice(tone)] : null;
  }
  // No ids, just spaces: the regex gave one back as the ids, which it can with three or more.
  return start - gap >= 3 ? [s.charAt(tone - 2), s.slice(tone)] : null;
}

export const unquote = (s: string) => s.replace(/^"(.*)"$/s, "$1").replace(/<br\s*\/?>/gi, "\n");

export type NodeMatch = {
  len: number;
  id: string;
  label: string | null;
  shape: FlowShape;
  tone: string | null;
};

export function nodeAt(s: string): NodeMatch | null {
  const id = ID.exec(s)?.[0];
  if (!id) {
    return null;
  }
  let len = id.length;
  let label: string | null = null;
  let shape: FlowShape = "box";
  for (const [open, close, sh] of SHAPES) {
    if (!s.startsWith(open, len)) {
      continue;
    }
    const body = s.slice(len + open.length);
    const quoted = /^"([^"]*)"/.exec(body);
    const end = quoted ? body.indexOf(close, quoted[0].length) : body.indexOf(close);
    if (end === -1) {
      return null;
    }
    label = unquote(body.slice(0, end).trim());
    shape = sh;
    len += open.length + end + close.length;
    break;
  }
  const tone = /^:::([\w-]+)/.exec(s.slice(len));
  if (tone) {
    len += tone[0].length;
  }
  return { len, id, label, shape, tone: tone?.[1] ?? null };
}
