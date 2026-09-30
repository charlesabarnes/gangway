import { edgeTone, type FlowGraph, type FlowNode } from "@gangway/shared/artifact/flow";
import type {
  FlowLayout,
  PlacedEdge,
  PlacedGroup,
  PlacedNode,
  Size,
} from "@gangway/shared/artifact/flow-layout";
import { GROUP_HEAD } from "./flow-elk.ts";

const NS = "http://www.w3.org/2000/svg";
const HOUSE_SANS = '"IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
const HOUSE_MONO = '"IBM Plex Mono", ui-monospace, monospace';
let FONT = `600 13px ${HOUSE_SANS}`;
let DETAIL_FONT = `400 12px ${HOUSE_SANS}`;
let LABEL_FONT = `400 12px ${HOUSE_MONO}`;
let CODE_FONT = `400 11px ${HOUSE_MONO}`;
let GROUP_FONT = `600 11px ${HOUSE_SANS}`;
// The theme's corner radius (--radius), for box and round nodes and group boxes.
let RADIUS = 0;
const PAD_X = 14;
const PAD_Y = 10;
const MAX_W = 170;
const MAX_DETAIL_W = 210;

/**
 * A box's first paragraph is its name; each later one (after a `<br/>`) is a detail line under
 * it, in mono when the whole paragraph is `in backticks`.
 */
export type Line = { text: string; kind: "name" | "detail" | "code" };
const LOOK: Record<Line["kind"], { font: string; height: number; max: number }> = {
  name: { font: FONT, height: 17, max: MAX_W },
  detail: { font: DETAIL_FONT, height: 15, max: MAX_DETAIL_W },
  code: { font: CODE_FONT, height: 15, max: MAX_DETAIL_W },
};

/**
 * Measures and rounds as the page's theme draws: its sans and mono fonts, since boxes are
 * sized to their words, and its corner radius. Answers the font to load before measuring.
 */
export function useTheme(el: Element): string {
  const css = getComputedStyle(el);
  const sans = css.getPropertyValue("--font-sans").trim() || HOUSE_SANS;
  const mono = css.getPropertyValue("--font-mono").trim() || HOUSE_MONO;
  FONT = LOOK.name.font = `600 13px ${sans}`;
  DETAIL_FONT = LOOK.detail.font = `400 12px ${sans}`;
  CODE_FONT = LOOK.code.font = `400 11px ${mono}`;
  LABEL_FONT = `400 12px ${mono}`;
  GROUP_FONT = `600 11px ${sans}`;
  RADIUS = Number.parseFloat(css.getPropertyValue("--radius")) || 0;
  return FONT;
}

let counter = 0;
let canvas: CanvasRenderingContext2D | null = null;

export function measure(text: string, font = FONT): number {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) {
    return text.length * 7;
  }
  canvas.font = font;
  return canvas.measureText(text).width;
}

function kindOf(raw: string, i: number): Line["kind"] {
  if (i === 0) {
    return "name";
  }
  return /^\s*`[^`]+`\s*$/.test(raw) ? "code" : "detail";
}

export function wrap(label: string): Line[] {
  const out: Line[] = [];
  label.split("\n").forEach((raw, i) => {
    const kind = kindOf(raw, i);
    const { font, max } = LOOK[kind];
    let cur = "";
    for (const word of raw.replace(/`/g, "").split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && measure(next, font) > max) {
        out.push({ text: cur, kind });
        cur = word;
      } else {
        cur = next;
      }
    }
    out.push({ text: cur, kind });
  });
  return out;
}

/** A label as one line of plain words, for a note or a screen reader. */
export const plain = (label: string) => label.replace(/`/g, "").replace(/\n/g, ", ");

export function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, String(v));
  }
  parent?.appendChild(e);
  return e;
}

export function sizeFor(lines: Line[], n: FlowNode): Size {
  const text = Math.max(...lines.map((l) => measure(l.text, LOOK[l.kind].font)));
  const w = Math.max(64, text + PAD_X * 2);
  const h = lines.reduce((s, l) => s + LOOK[l.kind].height, 0) + PAD_Y * 2;
  switch (n.shape) {
    case "diamond":
      return { w: Math.max(w * 1.5, 96), h: Math.max(h * 1.7, 64) };
    case "circle": {
      const d = Math.max(w, h) + 8;
      return { w: d, h: d };
    }
    case "stadium":
      return { w: w + h * 0.6, h };
    case "cylinder":
      return { w, h: h + 12 };
    case "box":
    case "round":
      return { w, h };
  }
}

function shape(n: PlacedNode, g: SVGGElement): void {
  const { x, y, w, h } = n;
  const at = { x: x - w / 2, y: y - h / 2, width: w, height: h, class: "shape" };
  switch (n.shape) {
    case "circle":
      svg("circle", { cx: x, cy: y, r: w / 2, class: "shape" }, g);
      return;
    case "diamond":
      svg(
        "polygon",
        {
          points: `${x},${y - h / 2} ${x + w / 2},${y} ${x},${y + h / 2} ${x - w / 2},${y}`,
          class: "shape",
        },
        g,
      );
      return;
    case "cylinder": {
      const r = 6;
      const top = y - h / 2 + r;
      const bot = y + h / 2 - r;
      const l = x - w / 2;
      const rt = x + w / 2;
      svg(
        "path",
        {
          d: `M${l},${top} A${w / 2},${r} 0 0 1 ${rt},${top} V${bot} A${w / 2},${r} 0 0 1 ${l},${bot} Z M${l},${top} A${w / 2},${r} 0 0 0 ${rt},${top}`,
          class: "shape",
        },
        g,
      );
      return;
    }
    case "stadium":
      svg("rect", { ...at, rx: h / 2 }, g);
      return;
    case "round":
      svg("rect", { ...at, rx: Math.min(RADIUS + 10, h / 2) }, g);
      return;
    case "box":
      svg("rect", { ...at, rx: Math.min(RADIUS || 2, h / 2) }, g);
  }
}

function text(
  lines: Line[],
  { x, y }: { x: number; y: number },
  g: SVGGElement,
  cls: string,
): void {
  const t = svg("text", { x, y, class: cls }, g);
  let at = y - lines.reduce((s, l) => s + LOOK[l.kind].height, 0) / 2;
  for (const l of lines) {
    const h = LOOK[l.kind].height;
    const s = svg("tspan", { x, y: at + h / 2, class: l.kind }, t);
    s.textContent = l.text;
    at += h;
  }
}

function group(x: PlacedGroup, parent: SVGGElement): void {
  const g = svg("g", { class: `group${x.tone ? ` tone-${x.tone}` : ""}`, "data-id": x.id }, parent);
  svg("rect", { x: x.x, y: x.y, width: x.w, height: x.h, rx: RADIUS || 4, class: "gshape" }, g);
  const t = svg("text", { x: x.x + 12, y: x.y + GROUP_HEAD / 2 + 1, class: "glabel" }, g);
  t.textContent = x.label.toUpperCase();
}

export const groupLabelWidth = (label: string) => measure(label.toUpperCase(), GROUP_FONT) + 4;
export const edgeLabelWidth = (label: string) => measure(label, LABEL_FONT);

const pathD = (e: PlacedEdge) =>
  `M${e.start[0]},${e.start[1]}` +
  e.segments
    .map((s) => ` C${s.c1[0]},${s.c1[1]} ${s.c2[0]},${s.c2[1]} ${s.to[0]},${s.to[1]}`)
    .join("");

export type Drawn = {
  svg: SVGSVGElement;
  nodes: Map<string, SVGGElement>;
  edges: { e: PlacedEdge; g: SVGGElement; path: SVGPathElement }[];
};

/** One arrowhead per tone, made on first use: a marker does not take the colour of the line it ends. */
function arrowheads(defs: SVGElement, id: string): (tone: string | null) => string {
  const heads = new Map<string, string>();
  return (tone) => {
    const key = tone ?? "ink";
    const made = heads.get(key);
    if (made) {
      return made;
    }
    const ref = `${id}-a-${key}`;
    const m = svg(
      "marker",
      {
        id: ref,
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerUnits: "userSpaceOnUse",
        markerWidth: 10,
        markerHeight: 10,
        orient: "auto-start-reverse",
      },
      defs,
    );
    svg("path", { d: "M0,0 L10,5 L0,10 z", class: `arrowhead${tone ? ` tone-${tone}` : ""}` }, m);
    heads.set(key, ref);
    return ref;
  };
}

function nodeRole(n: PlacedNode, acts: boolean): string {
  if (n.link) {
    return "link";
  }
  return acts ? "button" : "img";
}

export function draw(
  host: HTMLElement,
  {
    graph,
    layout,
    lines,
    title,
  }: { graph: FlowGraph; layout: FlowLayout; lines: Map<string, Line[]>; title: string },
): Drawn {
  const id = `gwf${++counter}`;
  const s = svg("svg", {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    role: "group",
    "aria-label": title || "Flowchart",
  });
  const head = arrowheads(svg("defs", {}, s), id);

  const groupLayer = svg("g", { class: "groups" }, s);
  for (const x of [...layout.groups].sort((a, b) => a.depth - b.depth)) {
    group(x, groupLayer);
  }

  const edges: Drawn["edges"] = [];
  const edgeLayer = svg("g", { class: "edges" }, s);
  for (const e of layout.edges) {
    const tone = edgeTone(graph, e);
    const g = svg(
      "g",
      { class: `edge ${e.style}${e.back ? " back" : ""}${tone ? ` tone-${tone}` : ""}` },
      edgeLayer,
    );
    g.style.setProperty("--d", `${e.rank * 140 + 120}ms`);
    const path = svg("path", { d: pathD(e), class: "line", fill: "none" }, g);
    if (e.style !== "dotted") {
      path.setAttribute("pathLength", "1");
    }
    if (e.arrow !== "none") {
      path.setAttribute("marker-end", `url(#${head(tone)})`);
    }
    if (e.arrow === "both") {
      path.setAttribute("marker-start", `url(#${head(tone)})`);
    }
    if (e.label) {
      const lg = svg("g", { class: "elabel" }, g);
      const w = edgeLabelWidth(e.label) + 10;
      svg("rect", { x: e.labelAt[0] - w / 2, y: e.labelAt[1] - 10, width: w, height: 20 }, lg);
      const t = svg("text", { x: e.labelAt[0], y: e.labelAt[1] }, lg);
      t.textContent = e.label;
    }
    edges.push({ e, g, path });
  }

  const nodes = new Map<string, SVGGElement>();
  const nodeLayer = svg("g", { class: "nodes" }, s);
  for (const n of layout.nodes) {
    const acts = n.link !== null || n.note !== null;
    const g = svg(
      "g",
      {
        class: `node ${n.shape}${n.tone ? ` tone-${n.tone}` : ""}${acts ? " acts" : ""}`,
        tabindex: 0,
        role: nodeRole(n, acts),
        "aria-label": `${plain(n.label)}${n.note ? `. ${n.note}` : ""}`,
        "data-id": n.id,
      },
      nodeLayer,
    );
    g.style.setProperty("--d", `${n.rank * 140}ms`);
    g.style.transformOrigin = `${n.x}px ${n.y}px`;
    shape(n, g);
    text(lines.get(n.id) ?? wrap(n.label), n, g, "label");
    if (n.note) {
      svg("circle", { cx: n.x + n.w / 2 - 7, cy: n.y - n.h / 2 + 7, r: 3, class: "has-note" }, g);
    }
    nodes.set(n.id, g);
  }
  host.replaceChildren(s);
  return { svg: s, nodes, edges };
}
