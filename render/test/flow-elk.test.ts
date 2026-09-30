import { describe, expect, test } from "bun:test";
import { parseFlow } from "@gangway/shared/artifact/flow";
import { layoutElk, rounded, type Elk } from "../src/flow-elk.ts";

// elkjs picks its in-thread worker only when it sees a document, as in a browser tab.
(globalThis as { document?: unknown }).document ??= {};
const { default: ELK } = (await import("elkjs/lib/elk.bundled.js")) as unknown as {
  default: new () => Elk;
};

const size = () => ({ w: 120, h: 40 });
const width = (t: string) => t.length * 7;

const CHART = [
  "flowchart LR",
  "  web[Browser]",
  "  subgraph vps [VPS]",
  "    nginx[nginx]",
  "    subgraph prod [Production]",
  "      api[admin-backend]",
  "      store[public-store]",
  "    end",
  "  end",
  "  pg[(Postgres)]",
  "  web -->|https| nginx",
  "  nginx --> api",
  "  nginx --> store",
  "  api -->|SQL| pg",
  "  web --> prod",
].join("\n");

describe("laying out a chart with subgraphs", () => {
  test("every box sits inside each of its groups, and groups nest", async () => {
    const g = parseFlow(CHART);
    const l = await layoutElk(g, size, width, new ELK());
    const box = new Map(l.groups.map((x) => [x.id, x]));
    const inside = (id: string, x: number, y: number, w: number, h: number) => {
      const b = box.get(id)!;
      expect(x).toBeGreaterThanOrEqual(b.x);
      expect(y).toBeGreaterThanOrEqual(b.y + 20);
      expect(x + w).toBeLessThanOrEqual(b.x + b.w);
      expect(y + h).toBeLessThanOrEqual(b.y + b.h);
    };
    for (const n of l.nodes.filter((n) => n.group)) {
      inside(n.group!, n.x - n.w / 2, n.y - n.h / 2, n.w, n.h);
      if (n.group === "prod") {
        inside("vps", n.x - n.w / 2, n.y - n.h / 2, n.w, n.h);
      }
    }
    const prod = box.get("prod")!;
    inside("vps", prod.x, prod.y, prod.w, prod.h);
    expect(box.get("vps")!.depth).toBe(0);
    expect(prod.depth).toBe(1);
    expect(l.width).toBeGreaterThan(0);
  });

  test("lines run at right angles from box to box, labels sit on them", async () => {
    const g = parseFlow(CHART);
    const l = await layoutElk(g, size, width, new ELK());
    const at = new Map(l.nodes.map((n) => [n.id, n]));
    for (const e of l.edges) {
      const ends = [e.start, e.segments.at(-1)!.to];
      for (const [id, [x, y]] of [e.from, e.to].map((id, i) => [id, ends[i]!] as const)) {
        const n = at.get(id);
        if (!n) {
          continue;
        } // a line to a group ends on the group's edge
        expect(Math.abs(x - n.x)).toBeLessThanOrEqual(n.w / 2 + 1);
        expect(Math.abs(y - n.y)).toBeLessThanOrEqual(n.h / 2 + 1);
      }
      // Straight runs are horizontal or vertical; corners are the short rounded pieces.
      let from = e.start;
      for (const s of e.segments) {
        const straight = s.c1 === from;
        if (straight) {
          expect(from[0] === s.to[0] || from[1] === s.to[1]).toBe(true);
        }
        from = s.to;
      }
    }
    const sql = l.edges.find((e) => e.label === "SQL")!;
    expect(sql.labelAt[0]).toBeGreaterThan(at.get("api")!.x);
    expect(sql.labelAt[0]).toBeLessThan(at.get("pg")!.x);
  });

  test("boxes draw in by walk depth; a line to a group with its first box", async () => {
    const g = parseFlow(CHART);
    const l = await layoutElk(g, size, width, new ELK());
    const rank = Object.fromEntries(l.nodes.map((n) => [n.id, n.rank]));
    expect(rank).toEqual({ web: 0, nginx: 1, api: 2, store: 2, pg: 3 });
    expect(l.edges.find((e) => e.to === "prod")!.rank).toBe(0);
  });
});

describe("rounding a polyline's corners", () => {
  test("a straight line stays one piece; a corner becomes line, curve, line", () => {
    expect(
      rounded([
        [0, 0],
        [10, 0],
      ]).segments,
    ).toHaveLength(1);
    const r = rounded([
      [0, 0],
      [20, 0],
      [20, 20],
    ]);
    expect(r.segments.map((s) => s.to)).toEqual([
      [14, 0],
      [20, 6],
      [20, 20],
    ]);
  });
});
