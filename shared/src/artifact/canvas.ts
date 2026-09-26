// Where a canvas puts its frames and how its arrows run; pure, so the kit and tests share it.

export const CANVAS_LAYOUTS = ["grid", "row", "column"] as const;
export type CanvasLayout = (typeof CANVAS_LAYOUTS)[number];
export const FRAME_STYLES = ["card", "plain", "note"] as const;
export const FRAME_WIDTH = 400;
export const CANVAS_GAP = 80;

export type Box = { x: number; y: number; w: number; h: number };
/** A frame as written: its measured size, and a position when the author gave one. */
export type FrameSpec = {
  id: string;
  w: number;
  h: number;
  x?: number | undefined;
  y?: number | undefined;
};
export type LayoutOptions = { layout: CanvasLayout; columns: number; gap: number };

/** Frames with x and y stay there; the rest flow from 0,0 in a row, a column or a grid. */
export function layoutFrames(frames: readonly FrameSpec[], o: LayoutOptions): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const f of frames)
    if (f.x !== undefined && f.y !== undefined) out.set(f.id, { x: f.x, y: f.y, w: f.w, h: f.h });
  const flow = frames.filter((f) => !out.has(f.id));
  const perRow =
    o.layout === "row" ? flow.length : o.layout === "column" ? 1 : Math.max(1, o.columns);
  let y = 0;
  for (let i = 0; i < flow.length; i += perRow) {
    const row = flow.slice(i, i + perRow);
    let x = 0;
    for (const f of row) {
      out.set(f.id, { x, y, w: f.w, h: f.h });
      x += f.w + o.gap;
    }
    y += Math.max(...row.map((f) => f.h)) + o.gap;
  }
  return out;
}

export function bounds(boxes: Iterable<Box>): Box {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

type Side = "left" | "right" | "top" | "bottom";
type Point = { x: number; y: number };

function anchor(b: Box, side: Side): Point {
  switch (side) {
    case "left":
      return { x: b.x, y: b.y + b.h / 2 };
    case "right":
      return { x: b.x + b.w, y: b.y + b.h / 2 };
    case "top":
      return { x: b.x + b.w / 2, y: b.y };
    case "bottom":
      return { x: b.x + b.w / 2, y: b.y + b.h };
  }
}

const OUT: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

/** An arrow leaves the side facing its target and enters the side facing its source. */
export function connector(a: Box, b: Box): { d: string; mid: Point; end: Point; toward: Side } {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  const across = Math.abs(dx) * Math.max(a.h, b.h) >= Math.abs(dy) * Math.max(a.w, b.w);
  const from: Side = across ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "bottom" : "top";
  const to: Side = across ? (dx >= 0 ? "left" : "right") : dy >= 0 ? "top" : "bottom";
  const p = anchor(a, from);
  const q = anchor(b, to);
  const pull = Math.max(40, Math.hypot(q.x - p.x, q.y - p.y) / 3);
  const c1 = { x: p.x + OUT[from].x * pull, y: p.y + OUT[from].y * pull };
  const c2 = { x: q.x + OUT[to].x * pull, y: q.y + OUT[to].y * pull };
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    d: `M${r(p.x)},${r(p.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(q.x)},${r(q.y)}`,
    mid: {
      x: r(0.125 * p.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * q.x),
      y: r(0.125 * p.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * q.y),
    },
    end: q,
    toward: to,
  };
}

/** The scale and offset that show `world` inside a viewport, with a margin, within limits. */
export function fit(
  world: Box,
  view: { w: number; h: number },
  margin = 48,
  limits: [number, number] = [0.05, 1],
): { k: number; x: number; y: number } {
  const k = Math.min(
    limits[1],
    Math.max(
      limits[0],
      Math.min(
        (view.w - margin * 2) / Math.max(1, world.w),
        (view.h - margin * 2) / Math.max(1, world.h),
      ),
    ),
  );
  return {
    k,
    x: (view.w - world.w * k) / 2 - world.x * k,
    y: (view.h - world.h * k) / 2 - world.y * k,
  };
}
