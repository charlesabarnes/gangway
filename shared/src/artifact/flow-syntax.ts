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

// Longest forms first: "-- text -->" before "--", "-.->" before "-.-".
const EDGES: [RegExp, FlowEdgeStyle, FlowEdge["arrow"]][] = [
  [/^<-{2,}>/, "solid", "both"],
  [/^<={2,}>/, "thick", "both"],
  [/^<-\.+->/, "dotted", "both"],
  [/^--\s+(.+?)\s+-{2,}(?:>|[xo](?=\s))/, "solid", "end"],
  [/^-\.\s+(.+?)\s+\.+->/, "dotted", "end"],
  [/^==\s+(.+?)\s+={2,}>/, "thick", "end"],
  [/^-{2,}(?:>|[xo](?=\s))/, "solid", "end"],
  [/^-\.+->/, "dotted", "end"],
  [/^={2,}>/, "thick", "end"],
  [/^-{3,}/, "solid", "none"],
  [/^-\.+-/, "dotted", "none"],
  [/^={3,}/, "thick", "none"],
];

export function edgeAt(text: string): EdgeMatch | null {
  const named = /^([\p{L}\p{N}_]+)@(?=[-=<.])/u.exec(text);
  const s = named ? text.slice(named[0].length) : text;
  for (const [re, style, arrow] of EDGES) {
    const m = re.exec(s);
    if (!m) {
      continue;
    }
    let len = m[0].length + (named?.[0].length ?? 0);
    let label = m[1] ?? "";
    const pipe = /^\s*\|([^|]*)\|/.exec(text.slice(len));
    if (pipe) {
      label = must(pipe[1], "a pipe label");
      len += pipe[0].length;
    }
    return { len, id: named?.[1] ?? null, label: unquote(label.trim()), style, arrow };
  }
  return null;
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
