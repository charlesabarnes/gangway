import { ancestors, type FlowGraph, type FlowNode } from "@gangway/shared/artifact/flow";
import type {
  FlowLayout,
  PlacedEdge,
  PlacedGroup,
  PlacedNode,
  Point,
  Segment,
  Size,
} from "@gangway/shared/artifact/flow-layout";

// Charts with subgraphs are laid out by ELK: boxes nest inside their groups and lines turn at
// right angles around them. ELK is big, so the kit fetches it only for a chart that needs it.

type ElkNode = {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: ElkEdge[];
  labels?: { text: string; width: number; height: number; x?: number; y?: number }[];
};
type ElkPoint = { x: number; y: number };
type ElkEdge = {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkNode["labels"];
  sections?: { startPoint: ElkPoint; endPoint: ElkPoint; bendPoints?: ElkPoint[] }[];
};
export type Elk = { layout(graph: ElkNode): Promise<ElkNode> };

const DIRECTION = { TB: "DOWN", BT: "UP", LR: "RIGHT", RL: "LEFT" } as const;
/** Room above a group's contents for its title. */
export const GROUP_HEAD = 30;
const GROUP_PAD = 14;
const CORNER = 6;
const LABEL_H = 20;

let loading: Promise<Elk> | null = null;

/** ELK, from the file beside the kit, once per page. */
export function loadElk(): Promise<Elk> {
  loading ??= (async () => {
    const kit = new URL(import.meta.url);
    const url = new URL(`elk.js${kit.search}`, kit).href;
    const mod = (await import(/* @vite-ignore */ url)) as { default: new () => Elk };
    return new mod.default();
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Walk depth from the starts: when each box draws in. */
function ranks(g: FlowGraph): Map<string, number> {
  const ids = new Set(g.nodes.map((n) => n.id));
  const edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const into = new Set(edges.map((e) => e.to));
  const rank = new Map<string, number>();
  const queue = g.nodes.filter((n) => !into.has(n.id)).map((n) => n.id);
  for (const id of queue) {
    rank.set(id, 0);
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges) {
      if (e.from === id && !rank.has(e.to)) {
        rank.set(e.to, rank.get(id)! + 1);
        queue.push(e.to);
      }
    }
  }
  for (const n of g.nodes) {
    if (!rank.has(n.id)) {
      rank.set(n.id, 0);
    }
  }
  return rank;
}

/** The ELK graph for a chart: groups become nested nodes, every line is declared at the root. */
export function elkGraph(
  g: FlowGraph,
  size: (n: FlowNode) => Size,
  labelWidth: (text: string, of: "edge" | "group") => number,
): ElkNode {
  const kids = new Map<string | null, ElkNode[]>();
  const add = (parent: string | null, n: ElkNode) =>
    kids.set(parent, [...(kids.get(parent) ?? []), n]);
  for (const n of g.nodes) {
    add(n.group, { id: n.id, ...toElkSize(size(n)) });
  }
  const groups = g.groups.map((x): { parent: string | null; node: ElkNode } => ({
    parent: x.parent,
    node: {
      id: x.id,
      labels: [{ text: x.label, width: labelWidth(x.label, "group"), height: 16 }],
      layoutOptions: {
        "elk.padding": `[top=${GROUP_HEAD},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${labelWidth(x.label, "group") + GROUP_PAD * 2}, ${GROUP_HEAD + 24})`,
      },
    },
  }));
  for (const x of groups) {
    add(x.parent, x.node);
  }
  for (const x of groups) {
    x.node.children = kids.get(x.node.id) ?? [];
  }
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": DIRECTION[g.direction],
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.edgeCoords": "ROOT",
      "elk.json.shapeCoords": "ROOT",
      "elk.padding": "[top=12,left=12,bottom=12,right=12]",
      "elk.spacing.nodeNode": "22",
      "elk.layered.spacing.nodeNodeBetweenLayers": "44",
      "elk.spacing.edgeNode": "14",
      "elk.spacing.edgeEdge": "10",
      "elk.layered.spacing.edgeNodeBetweenLayers": "14",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: kids.get(null) ?? [],
    edges: g.edges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.from],
      targets: [e.to],
      ...(e.label
        ? { labels: [{ text: e.label, width: labelWidth(e.label, "edge") + 10, height: LABEL_H }] }
        : {}),
    })),
  };
}

const toElkSize = (s: Size) => ({ width: s.w, height: s.h });

/** A polyline as gangway's segments, its corners rounded a little. */
export function rounded(points: Point[]): { start: Point; segments: Segment[] } {
  const start = points[0]!;
  const segments: Segment[] = [];
  let at = start;
  const line = (to: Point) => {
    segments.push({ c1: at, c2: to, to });
    at = to;
  };
  for (let i = 1; i < points.length - 1; i++) {
    const [p, q, r] = [points[i - 1]!, points[i]!, points[i + 1]!];
    const a = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const b = Math.hypot(r[0] - q[0], r[1] - q[1]);
    const k = Math.min(CORNER, a / 2, b / 2);
    if (k < 0.5) {
      continue;
    }
    const before: Point = [q[0] - ((q[0] - p[0]) / a) * k, q[1] - ((q[1] - p[1]) / a) * k];
    const after: Point = [q[0] + ((r[0] - q[0]) / b) * k, q[1] + ((r[1] - q[1]) / b) * k];
    line(before);
    segments.push({ c1: q, c2: q, to: after });
    at = after;
  }
  line(points.at(-1)!);
  return { start, segments };
}

/** ELK's answer as gangway's layout: boxes by their centres, groups by their corners. */
export function fromElk(g: FlowGraph, out: ElkNode, size: (n: FlowNode) => Size): FlowLayout {
  const placed = new Map<string, ElkNode>();
  const visit = (n: ElkNode) => {
    placed.set(n.id, n);
    for (const c of n.children ?? []) {
      visit(c);
    }
  };
  visit(out);
  const rank = ranks(g);
  const nodes: PlacedNode[] = g.nodes.map((n) => {
    const p = placed.get(n.id)!;
    const s = size(n);
    return { ...n, x: p.x! + s.w / 2, y: p.y! + s.h / 2, w: s.w, h: s.h, rank: rank.get(n.id)! };
  });
  const groups: PlacedGroup[] = g.groups.map((x) => {
    const p = placed.get(x.id)!;
    return { ...x, x: p.x!, y: p.y!, w: p.width!, h: p.height!, depth: ancestors(g, x.id).length };
  });
  // A line to a group draws in with the first box inside it.
  const edgeRank = (id: string) => {
    if (rank.has(id)) {
      return rank.get(id)!;
    }
    const inside = g.nodes.filter((n) => ancestors(g, n.id).some((a) => a.id === id));
    return inside.length ? Math.min(...inside.map((n) => rank.get(n.id)!)) : 0;
  };
  const byId = new Map((out.edges ?? []).map((e) => [e.id, e]));
  const edges: PlacedEdge[] = g.edges.map((e, i) => {
    const r = byId.get(`e${i}`);
    const sec = r?.sections?.[0];
    const pts: Point[] = sec
      ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => [p.x, p.y])
      : [
          [0, 0],
          [0, 0],
        ];
    const l = r?.labels?.[0];
    const mid = pts[Math.floor(pts.length / 2)]!;
    return {
      ...e,
      ...rounded(pts),
      labelAt: l ? [l.x! + (l.width ?? 0) / 2, l.y! + (l.height ?? 0) / 2] : mid,
      rank: Math.min(edgeRank(e.from), edgeRank(e.to)),
      back: false,
    };
  });
  return { nodes, edges, groups, width: out.width!, height: out.height! };
}

export async function layoutElk(
  g: FlowGraph,
  size: (n: FlowNode) => Size,
  labelWidth: (text: string, of: "edge" | "group") => number,
  elk: Elk,
): Promise<FlowLayout> {
  const out = await elk.layout(elkGraph(g, size, labelWidth));
  return fromElk(g, out, size);
}
