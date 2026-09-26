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
  /** The innermost subgraph it sits in. */
  group: string | null;
  line: number;
};
export type FlowEdge = {
  /** Mermaid's edge id (`a e1@--> b`), so `class e1 warn` can tone it. */
  id: string | null;
  /** A node's id or a group's. */
  from: string;
  to: string;
  label: string;
  style: FlowEdgeStyle;
  arrow: "none" | "end" | "both";
  tone: FlowTone | null;
  line: number;
};
export type FlowEdgeStyle = "solid" | "dotted" | "thick";
/** A subgraph: drawn as a labelled box around what it holds. */
export type FlowGroup = {
  id: string;
  label: string;
  parent: string | null;
  tone: FlowTone | null;
  line: number;
};
/** One line of the key under the chart: a sample of a line's tone and style, and what it means. */
export type FlowLegendItem = { tone: FlowTone | null; style: FlowEdgeStyle; text: string };
export type FlowIssue = { line: number; message: string };
export type FlowGraph = {
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
  groups: FlowGroup[];
  legend: FlowLegendItem[];
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

function edgeAt(text: string): EdgeMatch | null {
  const named = /^([\p{L}\p{N}_]+)@(?=[-=<.])/u.exec(text);
  const s = named ? text.slice(named[0].length) : text;
  for (const [re, style, arrow] of EDGES) {
    const m = re.exec(s);
    if (!m) continue;
    let len = m[0].length + (named?.[0].length ?? 0);
    let label = m[1] ?? "";
    const pipe = /^\s*\|([^|]*)\|/.exec(text.slice(len));
    if (pipe) {
      label = pipe[1]!;
      len += pipe[0].length;
    }
    return { len, id: named?.[1] ?? null, label: unquote(label.trim()), style, arrow };
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

type Builder = FlowGraph & {
  byId: Map<string, FlowNode>;
  /** Ids that were only ever referenced, never given a label: they may name a group. */
  bare: Set<string>;
  /** The subgraphs open at this line, innermost last. */
  open: FlowGroup[];
  /** `class` lines, applied once every node, group and edge id is known. */
  classes: { id: string; tone: string; line: number }[];
};

function touch(g: Builder, m: NodeMatch, line: number): void {
  let n = g.byId.get(m.id);
  if (!n) {
    n = {
      id: m.id,
      label: m.id,
      shape: "box",
      tone: null,
      link: null,
      note: null,
      group: null,
      line,
    };
    g.byId.set(m.id, n);
    g.nodes.push(n);
    g.bare.add(m.id);
  }
  // As in Mermaid, a node mentioned inside a subgraph moves into it.
  const inside = g.open.at(-1);
  if (inside) n.group = inside.id;
  if (m.label !== null) {
    n.label = m.label;
    n.shape = m.shape;
    g.bare.delete(m.id);
  }
  if (m.tone) setTone(g, n, m.tone, line);
}

function toneOf(g: Builder, tone: string, line: number): FlowTone | null {
  if ((FLOW_TONES as readonly string[]).includes(tone)) return tone as FlowTone;
  g.issues.push({ line, message: `class ${tone}: one of ${FLOW_TONES.join(" | ")}` });
  return null;
}

function setTone(g: Builder, n: { tone: FlowTone | null }, tone: string, line: number): void {
  const t = toneOf(g, tone, line);
  if (t) n.tone = t;
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
    g.edges.push({
      id: e.id,
      from: prev,
      to: next.id,
      label: e.label,
      style: e.style,
      arrow: e.arrow,
      tone: null,
      line,
    });
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

/** `subgraph id [Title]`, `subgraph id["Title"]`, `subgraph "Title"` or `subgraph Title`. */
function subgraph(g: Builder, rest: string, line: number): void {
  const toned = /:::([\w-]+)$/.exec(rest);
  const head = (toned ? rest.slice(0, toned.index) : rest).trim();
  const titled = /^([\p{L}\p{N}_]+)\s*\[(.*)\]$/su.exec(head);
  const bareId = /^[\p{L}\p{N}_]+$/u.test(head);
  const id = titled?.[1] ?? (bareId ? head : `subgraph${g.groups.length + 1}`);
  const label = titled ? unquote(titled[2]!.trim()) : unquote(head);
  const group: FlowGroup = { id, label, parent: g.open.at(-1)?.id ?? null, tone: null, line };
  // A second subgraph by the same name is reported once; its `end` still closes it.
  if (g.groups.some((x) => x.id === id))
    g.issues.push({ line, message: `there are two subgraphs called ${id}` });
  else g.groups.push(group);
  if (toned) setTone(g, group, toned[1]!, line);
  g.open.push(group);
}

const LEGEND_STYLES: Record<string, FlowEdgeStyle> = {
  solid: "solid",
  dotted: "dotted",
  dashed: "dotted",
  thick: "thick",
};

/** `legend warn dotted: staging path`: a line of the key under the chart. */
function legend(g: Builder, words: string, text: string, line: number): void {
  const item: FlowLegendItem = { tone: null, style: "solid", text: unquote(text.trim()) };
  for (const w of words.split(/\s+/).filter(Boolean)) {
    if (LEGEND_STYLES[w]) item.style = LEGEND_STYLES[w];
    else if ((FLOW_TONES as readonly string[]).includes(w)) item.tone = w as FlowTone;
    else
      return void g.issues.push({
        line,
        message: `legend ${w}: a tone (${FLOW_TONES.join(" | ")}) or a line (solid | dashed | thick)`,
      });
  }
  g.legend.push(item);
}

function statement(g: Builder, s: string, line: number): void {
  if (header(g, s, line)) return;
  const dir = /^direction\s+(\w+)$/i.exec(s);
  // Inside a subgraph the chart's own direction holds: groups are laid out with the whole chart.
  if (dir) return g.open.length ? undefined : direction(g, dir[1]!, line);
  const sub = /^subgraph\b\s*(.*)$/.exec(s);
  if (sub) {
    if (!sub[1]) return void g.issues.push({ line, message: "a subgraph needs a name" });
    return subgraph(g, sub[1], line);
  }
  if (s === "end") {
    if (!g.open.pop()) g.issues.push({ line, message: "end without a subgraph to close" });
    return;
  }
  // Styling is Mermaid's; gangway draws its own.
  if (/^(classDef|style|linkStyle)\b/.test(s)) return;
  const key = /^legend\b([^:]*):(.+)$/.exec(s);
  if (key) return legend(g, key[1]!, key[2]!, line);
  const cls = /^class\s+([\p{L}\p{N}_,\s]+?)\s+([\w-]+)$/u.exec(s);
  if (cls) {
    for (const id of cls[1]!.split(",").map((x) => x.trim()))
      g.classes.push({ id, tone: cls[2]!, line });
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
/** Ids only ever referenced that name a group are the group; `class` lines land last. */
function settle(g: Builder): void {
  for (const open of g.open)
    g.issues.push({ line: open.line, message: `subgraph ${open.id} is never closed with end` });
  const groups = new Map(g.groups.map((x) => [x.id, x]));
  for (const n of g.nodes)
    if (groups.has(n.id) && !g.bare.has(n.id))
      g.issues.push({ line: n.line, message: `${n.id} is both a node and a subgraph` });
  g.nodes = g.nodes.filter((n) => !(groups.has(n.id) && g.bare.has(n.id)));
  const edges = new Map(g.edges.filter((e) => e.id).map((e) => [e.id!, e]));
  for (const c of g.classes) {
    const target = groups.get(c.id) ?? edges.get(c.id);
    if (target) setTone(g, target, c.tone, c.line);
    else touch(g, { len: 0, id: c.id, label: null, shape: "box", tone: c.tone }, c.line);
  }
}

export function parseFlow(src: string, first = 1, dir?: string): FlowGraph {
  const g: Builder = {
    direction: "TB",
    nodes: [],
    edges: [],
    groups: [],
    legend: [],
    issues: [],
    byId: new Map(),
    bare: new Set(),
    open: [],
    classes: [],
  };
  if (dir) direction(g, dir, first - 1);
  src.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.replace(/%%.*$/, "");
    for (const part of text.split(";")) {
      const s = part.trim();
      if (s) statement(g, s, first + i);
    }
  });
  settle(g);
  if (g.nodes.length === 0) g.issues.push({ line: first, message: "the flowchart has no nodes" });
  if (g.nodes.length > MAX_FLOW_NODES)
    g.issues.push({
      line: first,
      message: `${g.nodes.length} nodes is more than a reader can follow (${MAX_FLOW_NODES} at most); split it`,
    });
  const { byId: _byId, bare: _bare, open: _open, classes: _classes, ...graph } = g;
  return graph;
}

/** The subgraphs holding a node or a group, innermost first. */
export function ancestors(g: FlowGraph, id: string): FlowGroup[] {
  const groups = new Map(g.groups.map((x) => [x.id, x]));
  const out: FlowGroup[] = [];
  let at = groups.get(id)?.parent ?? g.nodes.find((n) => n.id === id)?.group ?? null;
  while (at) {
    const x = groups.get(at);
    if (!x) break;
    out.push(x);
    at = x.parent;
  }
  return out;
}

/**
 * A line's tone: its own, else that of the toned group it leaves from (or is), else the one it
 * arrives in, so a staging path reads as staging without toning every line.
 */
export function edgeTone(g: FlowGraph, e: FlowEdge): FlowTone | null {
  if (e.tone) return e.tone;
  const toned = (id: string) => {
    const self = g.groups.find((x) => x.id === id);
    return [...(self ? [self] : []), ...ancestors(g, id)].find((x) => x.tone)?.tone ?? null;
  };
  return toned(e.from) ?? toned(e.to);
}
