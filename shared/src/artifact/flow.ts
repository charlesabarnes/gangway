/**
 * Flowcharts in Mermaid's flowchart syntax (the subset people write), parsed and laid out here
 * so the linter and the kit agree on what a diagram means.
 */

export const FLOW_DIRECTIONS = ["TB", "TD", "BT", "LR", "RL"] as const;
export type FlowDirection = "TB" | "BT" | "LR" | "RL";
export const FLOW_SHAPES = ["box", "round", "stadium", "circle", "diamond", "cylinder"] as const;
export type FlowShape = (typeof FLOW_SHAPES)[number];
export const FLOW_TONES = ["flag", "ok", "warn", "danger", "muted"] as const;
export type FlowTone = (typeof FLOW_TONES)[number];

export type FlowNode = {
  id: string;
  label: string;
  shape: FlowShape;
  tone: FlowTone | null;
  link: string | null;
  note: string | null;
  line: number;
};
export type FlowEdge = {
  from: string;
  to: string;
  label: string;
  style: "solid" | "dotted" | "thick";
  arrow: "none" | "end" | "both";
  line: number;
};
export type FlowIssue = { line: number; message: string };
export type FlowGraph = {
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
  issues: FlowIssue[];
};

export const MAX_FLOW_NODES = 80;

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

type EdgeMatch = { len: number; label: string; style: FlowEdge["style"]; arrow: FlowEdge["arrow"] };

// Longest forms first: "-- text -->" before "--", "-.->" before "-.-".
const EDGES: [RegExp, FlowEdge["style"], FlowEdge["arrow"]][] = [
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

function edgeAt(s: string): EdgeMatch | null {
  for (const [re, style, arrow] of EDGES) {
    const m = re.exec(s);
    if (!m) continue;
    let len = m[0].length;
    let label = m[1] ?? "";
    const pipe = /^\s*\|([^|]*)\|/.exec(s.slice(len));
    if (pipe) {
      label = pipe[1]!;
      len += pipe[0].length;
    }
    return { len, label: unquote(label.trim()), style, arrow };
  }
  return null;
}

const unquote = (s: string) => s.replace(/^"(.*)"$/s, "$1").replace(/<br\s*\/?>/gi, "\n");

type NodeMatch = {
  len: number;
  id: string;
  label: string | null;
  shape: FlowShape;
  tone: string | null;
};

function nodeAt(s: string): NodeMatch | null {
  const id = ID.exec(s)?.[0];
  if (!id) return null;
  let len = id.length;
  let label: string | null = null;
  let shape: FlowShape = "box";
  for (const [open, close, sh] of SHAPES) {
    if (!s.startsWith(open, len)) continue;
    const body = s.slice(len + open.length);
    const quoted = /^"([^"]*)"/.exec(body);
    const end = quoted ? body.indexOf(close, quoted[0].length) : body.indexOf(close);
    if (end === -1) return null;
    label = unquote(body.slice(0, end).trim());
    shape = sh;
    len += open.length + end + close.length;
    break;
  }
  const tone = /^:::([\w-]+)/.exec(s.slice(len));
  if (tone) len += tone[0].length;
  return { len, id, label, shape, tone: tone?.[1] ?? null };
}

type Builder = FlowGraph & { byId: Map<string, FlowNode> };

function touch(g: Builder, m: NodeMatch, line: number): void {
  let n = g.byId.get(m.id);
  if (!n) {
    n = { id: m.id, label: m.id, shape: "box", tone: null, link: null, note: null, line };
    g.byId.set(m.id, n);
    g.nodes.push(n);
  }
  if (m.label !== null) {
    n.label = m.label;
    n.shape = m.shape;
  }
  if (m.tone) setTone(g, n, m.tone, line);
}

function setTone(g: Builder, n: FlowNode, tone: string, line: number): void {
  if ((FLOW_TONES as readonly string[]).includes(tone)) n.tone = tone as FlowTone;
  else g.issues.push({ line, message: `class ${tone}: one of ${FLOW_TONES.join(" | ")}` });
}

/** A chain like `A[Start] --> B{OK?} -->|yes| C`. */
function chain(g: Builder, text: string, line: number): void {
  let rest = text;
  const first = nodeAt(rest);
  if (!first) return void g.issues.push({ line, message: `can't read "${text}"` });
  touch(g, first, line);
  let prev = first.id;
  rest = rest.slice(first.len).trimStart();
  while (rest.length > 0) {
    if (rest.startsWith("&"))
      return void g.issues.push({
        line,
        message: "A & B is not supported; write one edge per line",
      });
    const e = edgeAt(rest);
    if (!e)
      return void g.issues.push({
        line,
        message: `expected an arrow (-->, -.->, ==>, ---) after ${prev}, found "${rest.slice(0, 20)}"`,
      });
    rest = rest.slice(e.len).trimStart();
    const next = nodeAt(rest);
    if (!next) return void g.issues.push({ line, message: `an arrow from ${prev} goes nowhere` });
    touch(g, next, line);
    g.edges.push({ from: prev, to: next.id, label: e.label, style: e.style, arrow: e.arrow, line });
    prev = next.id;
    rest = rest.slice(next.len).trimStart();
  }
}

function header(g: Builder, s: string, line: number): boolean {
  const m = /^(?:flowchart|graph)(?:\s+(\w+))?\s*$/i.exec(s);
  if (!m) return false;
  if (m[1]) direction(g, m[1], line);
  return true;
}

function direction(g: Builder, d: string, line: number): void {
  const up = d.toUpperCase();
  if ((FLOW_DIRECTIONS as readonly string[]).includes(up))
    g.direction = (up === "TD" ? "TB" : up) as FlowDirection;
  else g.issues.push({ line, message: `direction ${d}: one of TB | LR | BT | RL` });
}

function statement(g: Builder, s: string, line: number): void {
  if (header(g, s, line)) return;
  const dir = /^direction\s+(\w+)$/i.exec(s);
  if (dir) return direction(g, dir[1]!, line);
  // Styling and grouping are Mermaid's; gangway draws its own style and lays groups out flat.
  if (/^(classDef|style|linkStyle|subgraph|end)\b/.test(s)) return;
  const cls = /^class\s+([\p{L}\p{N}_,\s]+?)\s+([\w-]+)$/u.exec(s);
  if (cls) {
    for (const id of cls[1]!.split(",").map((x) => x.trim()))
      touch(g, { len: 0, id, label: null, shape: "box", tone: cls[2]! }, line);
    return;
  }
  const click = /^click\s+([\p{L}\p{N}_]+)\s+(?:href\s+)?"([^"]*)"(?:\s+"([^"]*)")?/u.exec(s);
  if (click) {
    touch(g, { len: 0, id: click[1]!, label: null, shape: "box", tone: null }, line);
    const n = g.byId.get(click[1]!)!;
    n.link = click[2]!;
    if (click[3]) n.note = click[3];
    return;
  }
  const note = /^note\s+([\p{L}\p{N}_]+)\s*:\s*(.+)$/u.exec(s);
  if (note) {
    touch(g, { len: 0, id: note[1]!, label: null, shape: "box", tone: null }, line);
    g.byId.get(note[1]!)!.note = unquote(note[2]!.trim());
    return;
  }
  chain(g, s, line);
}

/** Parse a flowchart; `first` is the line number of its first line, for messages. */
export function parseFlow(src: string, first = 1, dir?: string): FlowGraph {
  const g: Builder = { direction: "TB", nodes: [], edges: [], issues: [], byId: new Map() };
  if (dir) direction(g, dir, first - 1);
  src.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.replace(/%%.*$/, "");
    for (const part of text.split(";")) {
      const s = part.trim();
      if (s) statement(g, s, first + i);
    }
  });
  if (g.nodes.length === 0) g.issues.push({ line: first, message: "the flowchart has no nodes" });
  if (g.nodes.length > MAX_FLOW_NODES)
    g.issues.push({
      line: first,
      message: `${g.nodes.length} nodes is more than a reader can follow (${MAX_FLOW_NODES} at most); split it`,
    });
  const { byId: _byId, ...graph } = g;
  return graph;
}
