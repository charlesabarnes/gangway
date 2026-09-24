import type { FlowDirection, FlowEdge, FlowGraph, FlowNode } from "./flow.ts";

export type Size = { w: number; h: number };
export type Point = [number, number];
export type PlacedNode = FlowNode & { x: number; y: number; w: number; h: number; rank: number };
export type Segment = { c1: Point; c2: Point; to: Point };
export type PlacedEdge = FlowEdge & {
  start: Point;
  segments: Segment[];
  labelAt: Point;
  rank: number;
  back: boolean;
};
export type FlowLayout = {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
};

export type LayoutOptions = { rankGap?: number; nodeGap?: number; margin?: number };

type Vertex = { id: string; rank: number; cross: number; main: number; dummy: boolean };

/** Depth-first from each node in order of appearance; an edge back onto the stack closes a cycle. */
function backEdges(g: FlowGraph): Set<number> {
  const out = new Map<string, number[]>();
  g.edges.forEach((e, i) => out.set(e.from, [...(out.get(e.from) ?? []), i]));
  const state = new Map<string, 1 | 2>();
  const back = new Set<number>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const i of out.get(id) ?? []) {
      const to = g.edges[i]!.to;
      if (to === id) continue;
      const s = state.get(to);
      if (s === 1) back.add(i);
      else if (s === undefined) visit(to);
    }
    state.set(id, 2);
  };
  for (const n of g.nodes) if (!state.has(n.id)) visit(n.id);
  return back;
}

function ranks(g: FlowGraph, dag: [string, string][]): Map<string, number> {
  const rank = new Map(g.nodes.map((n) => [n.id, 0]));
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const [, to] of dag) indeg.set(to, indeg.get(to)! + 1);
  const queue = g.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const [from, to] of dag) {
      if (from !== id) continue;
      rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
      indeg.set(to, indeg.get(to)! - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  return rank;
}

function crossings(layers: Vertex[][], links: [Vertex, Vertex][]): number {
  const pos = new Map<Vertex, number>();
  for (const l of layers) l.forEach((v, i) => pos.set(v, i));
  let n = 0;
  for (let i = 0; i < links.length; i++)
    for (let j = i + 1; j < links.length; j++) {
      const [a, b] = links[i]!;
      const [c, d] = links[j]!;
      if (a.rank !== c.rank) continue;
      const x = pos.get(a)! - pos.get(c)!;
      const y = pos.get(b)! - pos.get(d)!;
      if (x * y < 0) n++;
    }
  return n;
}

function order(layers: Vertex[][], links: [Vertex, Vertex][]): Vertex[][] {
  const up = new Map<Vertex, Vertex[]>();
  const down = new Map<Vertex, Vertex[]>();
  for (const [a, b] of links) {
    down.set(a, [...(down.get(a) ?? []), b]);
    up.set(b, [...(up.get(b) ?? []), a]);
  }
  let best = layers.map((l) => [...l]);
  let bestCount = crossings(best, links);
  let cur = best.map((l) => [...l]);
  const sweep = (from: number, to: number, step: number, near: Map<Vertex, Vertex[]>) => {
    for (let r = from; r !== to; r += step) {
      const prev = new Map(cur[r - step]!.map((v, i) => [v, i]));
      const key = new Map(
        cur[r]!.map((v, i) => {
          const ns = (near.get(v) ?? []).map((n) => prev.get(n)!).filter((x) => x !== undefined);
          return [v, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i];
        }),
      );
      cur[r]!.sort((a, b) => key.get(a)! - key.get(b)!);
    }
  };
  for (let iter = 0; iter < 12 && bestCount > 0; iter++) {
    if (iter % 2 === 0) sweep(1, cur.length, 1, up);
    else sweep(cur.length - 2, -1, -1, down);
    const count = crossings(cur, links);
    if (count < bestCount) {
      bestCount = count;
      best = cur.map((l) => [...l]);
    }
    cur = cur.map((l) => [...l]);
  }
  return best;
}

/** Place a layer at the positions its neighbours pull it to, keeping its order and spacing. */
function settle(layer: Vertex[], want: number[], gap: number): void {
  const x = [...want];
  for (let i = 1; i < layer.length; i++) {
    const min = x[i - 1]! + (layer[i - 1]!.cross + layer[i]!.cross) / 2 + gap;
    if (x[i]! < min) x[i] = min;
  }
  const shift = want.reduce((s, w, i) => s + (w - x[i]!), 0) / Math.max(1, layer.length);
  layer.forEach((v, i) => (v.main = x[i]! + shift));
}

function coordinates(layers: Vertex[][], links: [Vertex, Vertex][], gap: number): void {
  for (const l of layers) {
    let at = 0;
    for (const v of l) {
      v.main = at + v.cross / 2;
      at += v.cross + gap;
    }
    const mid = at / 2;
    for (const v of l) v.main -= mid;
  }
  const near = new Map<Vertex, Vertex[]>();
  for (const [a, b] of links) {
    near.set(a, [...(near.get(a) ?? []), b]);
    near.set(b, [...(near.get(b) ?? []), a]);
  }
  for (let pass = 0; pass < 8; pass++) {
    const seq = pass % 2 === 0 ? layers : [...layers].reverse();
    for (const l of seq) {
      const want = l.map((v) => {
        const ns = near.get(v) ?? [];
        return ns.length ? ns.reduce((s, n) => s + n.main, 0) / ns.length : v.main;
      });
      settle(l, want, gap);
    }
  }
}

type Frame = { flip: boolean; swap: boolean };

function frameOf(d: FlowDirection): Frame {
  return { swap: d === "LR" || d === "RL", flip: d === "BT" || d === "RL" };
}

type Layered = {
  vert: Map<string, Vertex>;
  layers: Vertex[][];
  links: [Vertex, Vertex][];
  chains: Map<number, Vertex[]>;
};

/** One vertex per node in its rank, and a dummy in every rank a long edge passes through. */
function layered(
  g: FlowGraph,
  back: Set<number>,
  rank: Map<string, number>,
  cross: (id: string) => number,
): Layered {
  const vert = new Map<string, Vertex>(
    g.nodes.map((n) => [
      n.id,
      { id: n.id, rank: rank.get(n.id)!, cross: cross(n.id), main: 0, dummy: false },
    ]),
  );
  const top = Math.max(0, ...rank.values());
  const layers: Vertex[][] = Array.from({ length: top + 1 }, () => []);
  for (const n of g.nodes) layers[rank.get(n.id)!]!.push(vert.get(n.id)!);
  const links: [Vertex, Vertex][] = [];
  const chains = new Map<number, Vertex[]>();
  g.edges.forEach((e, i) => {
    if (e.from === e.to) return;
    const [a, b] = back.has(i) ? [e.to, e.from] : [e.from, e.to];
    const path = [vert.get(a)!];
    for (let r = rank.get(a)! + 1; r < rank.get(b)!; r++) {
      const d: Vertex = { id: `${i}:${r}`, rank: r, cross: 6, main: 0, dummy: true };
      layers[r]!.push(d);
      path.push(d);
    }
    path.push(vert.get(b)!);
    for (let k = 1; k < path.length; k++) links.push([path[k - 1]!, path[k]!]);
    chains.set(i, path);
  });
  return { vert, layers, links, chains };
}

type Placer = {
  rankAt: number[];
  depth: (id: string) => number;
  put: (main: number, along: number) => Point;
};

function routed(e: FlowEdge, path: Vertex[], isBack: boolean, rank: number, p: Placer): PlacedEdge {
  // Along the rank axis: leave the upper node's far side, reach the lower node's near side.
  const pts: [number, number][] = path.map((v, k) => {
    const along = p.rankAt[v.rank]!;
    if (k === 0) return [v.main, along + p.depth(v.id) / 2];
    if (k === path.length - 1) return [v.main, along - p.depth(v.id) / 2];
    return [v.main, along];
  });
  if (isBack) {
    // Off-centre, so a loop back does not sit on the arrow that came forward.
    const last = pts.length - 1;
    pts[0]![0] += Math.min(24, path[0]!.cross / 4);
    pts[last]![0] += Math.min(24, path[last]!.cross / 4);
    pts.reverse();
  }
  const segments: Segment[] = [];
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1]!;
    const [x1, y1] = pts[k]!;
    const mid = (y1 - y0) / 2;
    segments.push({ c1: p.put(x0, y0 + mid), c2: p.put(x1, y1 - mid), to: p.put(x1, y1) });
  }
  const m = pts[Math.floor((pts.length - 1) / 2)]!;
  const m2 = pts[Math.floor(pts.length / 2)]!;
  return {
    ...e,
    start: p.put(pts[0]![0], pts[0]![1]),
    segments,
    labelAt: p.put((m[0] + m2[0]) / 2, (m[1] + m2[1]) / 2),
    rank,
    back: isBack,
  };
}

/**
 * Layered layout (after Sugiyama): cycles broken depth-first, ranks by longest path, long edges
 * through dummy points, crossings reduced by barycentre sweeps. Works top-down, then turns.
 */
export function layoutFlow(
  g: FlowGraph,
  sizeOf: (n: FlowNode) => Size,
  o: LayoutOptions = {},
): FlowLayout {
  const f = frameOf(g.direction);
  const rankGap = o.rankGap ?? 56;
  const margin = o.margin ?? 12;
  const back = backEdges(g);
  const dag: [string, string][] = g.edges
    .map((e, i): [string, string] => (back.has(i) ? [e.to, e.from] : [e.from, e.to]))
    .filter(([a, b]) => a !== b);
  const rank = ranks(g, dag);

  // In the top-down frame, "cross" is the size across a rank and "depth" the size along it.
  const size = new Map(g.nodes.map((n) => [n.id, sizeOf(n)]));
  const cross = (id: string) => (f.swap ? size.get(id)!.h : size.get(id)!.w);
  const depth = (id: string) => (f.swap ? size.get(id)!.w : size.get(id)!.h);
  const L = layered(g, back, rank, cross);
  const ordered = order(L.layers, L.links);
  coordinates(ordered, L.links, o.nodeGap ?? 28);

  const rankAt: number[] = [];
  let acc = 0;
  for (const [r, l] of ordered.entries()) {
    const d = Math.max(0, ...l.filter((v) => !v.dummy).map((v) => depth(v.id)));
    rankAt[r] = acc + d / 2;
    acc += d + rankGap;
  }
  const all = ordered.flat();
  const minMain = Math.min(...all.map((v) => v.main - v.cross / 2));
  const spanMain = Math.max(...all.map((v) => v.main + v.cross / 2)) - minMain;
  const spanRank = Math.max(0, acc - rankGap);
  const put = (main: number, along: number): Point => {
    const m = main - minMain + margin;
    const a = f.flip ? spanRank - along + margin : along + margin;
    return f.swap ? [a, m] : [m, a];
  };

  const nodes: PlacedNode[] = g.nodes.map((n) => {
    const v = L.vert.get(n.id)!;
    const [x, y] = put(v.main, rankAt[v.rank]!);
    return { ...n, x, y, ...size.get(n.id)!, rank: v.rank };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placer = { rankAt, depth, put };
  const edges = g.edges.map((e, i) =>
    e.from === e.to
      ? selfLoop(e, byId.get(e.from)!, f)
      : routed(
          e,
          L.chains.get(i)!,
          back.has(i),
          Math.min(rank.get(e.from)!, rank.get(e.to)!),
          placer,
        ),
  );
  const [w, h] = f.swap ? [spanRank, spanMain] : [spanMain, spanRank];
  return { nodes, edges, width: w + margin * 2, height: h + margin * 2 };
}

function selfLoop(e: FlowEdge, n: PlacedNode, f: Frame): PlacedEdge {
  const r = 22;
  const [sx, sy, ex, ey, ox, oy]: number[] = f.swap
    ? [n.x - 10, n.y + n.h / 2, n.x + 10, n.y + n.h / 2, 0, r]
    : [n.x + n.w / 2, n.y - 8, n.x + n.w / 2, n.y + 8, r, 0];
  return {
    ...e,
    start: [sx!, sy!],
    segments: [
      {
        c1: [sx! + ox! * 1.6, sy! + oy! * 1.6 - (f.swap ? 0 : r)],
        c2: [ex! + ox! * 1.6, ey! + oy! * 1.6 + (f.swap ? 0 : r)],
        to: [ex!, ey!],
      },
    ],
    labelAt: [n.x + (f.swap ? 0 : n.w / 2 + r * 1.4), n.y + (f.swap ? n.h / 2 + r * 1.4 : 0)],
    rank: n.rank,
    back: false,
  };
}

/** Nodes in the order a reader walks them: breadth-first from the starts, along the edges. */
export function walkOrder(g: FlowGraph): string[] {
  const back = backEdges(g);
  const into = new Set(g.edges.filter((e, i) => !back.has(i) && e.from !== e.to).map((e) => e.to));
  const starts = g.nodes.filter((n) => !into.has(n.id)).map((n) => n.id);
  const seen = new Set<string>();
  const out: string[] = [];
  const queue = starts.length ? [...starts] : g.nodes.slice(0, 1).map((n) => n.id);
  while (queue.length || out.length < g.nodes.length) {
    if (!queue.length) queue.push(g.nodes.find((n) => !seen.has(n.id))!.id);
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const e of g.edges) if (e.from === id && !seen.has(e.to)) queue.push(e.to);
  }
  return out;
}
