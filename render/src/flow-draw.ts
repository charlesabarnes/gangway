import type { FlowNode } from "@gangway/shared/artifact/flow";
import type {
  FlowLayout,
  PlacedEdge,
  PlacedNode,
  Size,
} from "@gangway/shared/artifact/flow-layout";

const NS = "http://www.w3.org/2000/svg";
export const FONT = '600 13px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
const LABEL_FONT = '400 12px "IBM Plex Mono", ui-monospace, monospace';
const LINE = 17;
const PAD_X = 14;
const PAD_Y = 10;
const MAX_W = 170;

let counter = 0;
let canvas: CanvasRenderingContext2D | null = null;

export function measure(text: string, font = FONT): number {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return text.length * 7;
  canvas.font = font;
  return canvas.measureText(text).width;
}

export function wrap(label: string): string[] {
  const out: string[] = [];
  for (const para of label.split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && measure(next) > MAX_W) {
        out.push(cur);
        cur = word;
      } else cur = next;
    }
    out.push(cur);
  }
  return out;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

export function sizeFor(lines: string[], n: FlowNode): Size {
  const text = Math.max(...lines.map((l) => measure(l)));
  const w = Math.max(64, text + PAD_X * 2);
  const h = lines.length * LINE + PAD_Y * 2;
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
    default:
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
    default:
      svg("rect", { ...at, rx: n.shape === "stadium" ? h / 2 : n.shape === "round" ? 10 : 2 }, g);
  }
}

function text(lines: string[], x: number, y: number, g: SVGGElement, cls: string): void {
  const t = svg("text", { x, y: y - ((lines.length - 1) * LINE) / 2, class: cls }, g);
  lines.forEach((l, i) => {
    const s = svg("tspan", { x, dy: i === 0 ? 0 : LINE }, t);
    s.textContent = l;
  });
}

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

export function draw(
  host: HTMLElement,
  layout: FlowLayout,
  lines: Map<string, string[]>,
  title: string,
): Drawn {
  const id = `gwf${++counter}`;
  const s = svg("svg", {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    role: "group",
    "aria-label": title || "Flowchart",
  });
  const defs = svg("defs", {}, s);
  const arrow = svg(
    "marker",
    {
      id: `${id}-a`,
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
  svg("path", { d: "M0,0 L10,5 L0,10 z", class: "arrowhead" }, arrow);

  const edges: Drawn["edges"] = [];
  const edgeLayer = svg("g", { class: "edges" }, s);
  for (const e of layout.edges) {
    const g = svg("g", { class: `edge ${e.style}${e.back ? " back" : ""}` }, edgeLayer);
    g.style.setProperty("--d", `${e.rank * 140 + 120}ms`);
    const path = svg("path", { d: pathD(e), class: "line", fill: "none" }, g);
    if (e.style !== "dotted") path.setAttribute("pathLength", "1");
    if (e.arrow !== "none") path.setAttribute("marker-end", `url(#${id}-a)`);
    if (e.arrow === "both") path.setAttribute("marker-start", `url(#${id}-a)`);
    if (e.label) {
      const lg = svg("g", { class: "elabel" }, g);
      const w = measure(e.label, LABEL_FONT) + 10;
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
        role: n.link ? "link" : acts ? "button" : "img",
        "aria-label": `${n.label}${n.note ? `. ${n.note}` : ""}`,
        "data-id": n.id,
      },
      nodeLayer,
    );
    g.style.setProperty("--d", `${n.rank * 140}ms`);
    g.style.transformOrigin = `${n.x}px ${n.y}px`;
    shape(n, g);
    text(lines.get(n.id) ?? [n.label], n.x, n.y, g, "label");
    if (n.note)
      svg("circle", { cx: n.x + n.w / 2 - 7, cy: n.y - n.h / 2 + 7, r: 3, class: "has-note" }, g);
    nodes.set(n.id, g);
  }
  host.replaceChildren(s);
  return { svg: s, nodes, edges };
}
