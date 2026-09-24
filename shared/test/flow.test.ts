import { describe, expect, test } from "bun:test";
import { layoutFlow, walkOrder } from "../src/artifact/flow-layout.ts";
import { parseFlow, type FlowGraph } from "../src/artifact/flow.ts";
import { scan } from "../src/artifact/grammar.ts";
import { lintMarkdown } from "../src/artifact/lint.ts";

const box = () => ({ w: 100, h: 40 });

describe("parsing a flowchart", () => {
  test("reads Mermaid's shapes, arrows, labels and chains", () => {
    const g = parseFlow(
      [
        "flowchart LR",
        "  a([Start]) --> b{OK?}",
        "  b -->|yes| c[Ship it] --> d((Done))",
        "  b -- no --> e[(Store)]",
        "  e -.-> b",
        "  c ==> d",
        "  d --- f(Rounded)",
        "  a <--> f",
      ].join("\n"),
    );
    expect(g.issues).toEqual([]);
    expect(g.direction).toBe("LR");
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.shape]))).toEqual({
      a: "stadium",
      b: "diamond",
      c: "box",
      d: "circle",
      e: "cylinder",
      f: "round",
    });
    expect(g.edges.map((e) => `${e.from}>${e.to}:${e.label}:${e.style}:${e.arrow}`)).toEqual([
      "a>b::solid:end",
      "b>c:yes:solid:end",
      "c>d::solid:end",
      "b>e:no:solid:end",
      "e>b::dotted:end",
      "c>d::thick:end",
      "d>f::solid:none",
      "a>f::solid:both",
    ]);
  });

  test("tones, notes, links, comments and the Mermaid bits it ignores", () => {
    const g = parseFlow(
      [
        "graph TD",
        "  %% a comment",
        "  a[Ask]:::warn --> b[Answer]",
        "  class b ok",
        '  click a "#details" "Opens the details"',
        "  note b: What the answer means.",
        "  classDef hot fill:#f00",
        "  subgraph Group",
        "  end",
      ].join("\n"),
    );
    expect(g.issues).toEqual([]);
    expect(g.direction).toBe("TB");
    const [a, b] = g.nodes;
    expect(a).toMatchObject({ tone: "warn", link: "#details", note: "Opens the details" });
    expect(b).toMatchObject({ tone: "ok", note: "What the answer means." });
  });

  test("a node referenced before it is defined takes the later label", () => {
    const g = parseFlow("a --> b\nb[Second]");
    expect(g.nodes.find((n) => n.id === "b")).toMatchObject({ label: "Second", shape: "box" });
  });

  test("names the line of each mistake", () => {
    const g = parseFlow("a --> b\na --> \nc ~~ d\nclass a loud", 10);
    expect(g.issues).toEqual([
      { line: 11, message: "an arrow from a goes nowhere" },
      { line: 12, message: 'expected an arrow (-->, -.->, ==>, ---) after c, found "~~ d"' },
      { line: 13, message: "class loud: one of flag | ok | warn | danger | muted" },
    ]);
  });

  test("an empty chart and a direction it does not know are problems", () => {
    expect(parseFlow("%% nothing").issues[0]!.message).toContain("no nodes");
    expect(parseFlow("flowchart XY\na").issues[0]!.message).toContain("direction XY");
  });
});

const ranksOf = (g: FlowGraph) => {
  const l = layoutFlow(g, box);
  return new Map(l.nodes.map((n) => [n.id, n]));
};

describe("laying a flowchart out", () => {
  test("every edge points down the page, and nodes in a rank do not overlap", () => {
    const g = parseFlow("a --> b\na --> c\nb --> d\nc --> d\nd --> e\na --> e");
    const l = layoutFlow(g, box);
    const at = new Map(l.nodes.map((n) => [n.id, n]));
    for (const e of g.edges) expect(at.get(e.to)!.y).toBeGreaterThan(at.get(e.from)!.y);
    const byRank = new Map<number, typeof l.nodes>();
    for (const n of l.nodes) byRank.set(n.rank, [...(byRank.get(n.rank) ?? []), n]);
    for (const row of byRank.values()) {
      const xs = row.map((n) => n.x).sort((p, q) => p - q);
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(100);
    }
    for (const n of l.nodes) {
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w / 2).toBeLessThanOrEqual(l.width);
    }
  });

  test("a cycle is drawn, with the edge that closes it marked as going back", () => {
    const g = parseFlow("a --> b\nb --> c\nc -->|retry| b");
    const l = layoutFlow(g, box);
    expect(l.edges.map((e) => e.back)).toEqual([false, false, true]);
    const at = ranksOf(g);
    expect(at.get("c")!.rank).toBeGreaterThan(at.get("b")!.rank);
  });

  test("left to right runs along x; bottom to top runs up", () => {
    const lr = ranksOf(parseFlow("flowchart LR\na --> b"));
    expect(lr.get("b")!.x).toBeGreaterThan(lr.get("a")!.x);
    expect(lr.get("b")!.y).toBe(lr.get("a")!.y);
    const bt = ranksOf(parseFlow("flowchart BT\na --> b"));
    expect(bt.get("b")!.y).toBeLessThan(bt.get("a")!.y);
  });

  test("a long edge bends through the ranks it crosses", () => {
    const l = layoutFlow(parseFlow("a --> b --> c --> d\na --> d"), box);
    expect(l.edges.at(-1)!.segments).toHaveLength(3);
  });

  test("a self-loop does not break the layout", () => {
    const l = layoutFlow(parseFlow("a --> a\na --> b"), box);
    expect(l.nodes).toHaveLength(2);
    expect(l.edges[0]!.segments).toHaveLength(1);
  });

  test("the walk goes from the starts along the edges", () => {
    expect(walkOrder(parseFlow("a --> b\na --> c\nb --> d\nc --> d\nd -.-> a"))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("flowcharts in artifact.md", () => {
  test("a flow or flowchart mermaid fence is a flow; other mermaid stays code", () => {
    const blocks = scan([
      "```flow title=A",
      "a --> b",
      "```",
      "```mermaid",
      "flowchart LR",
      "a --> b",
      "```",
      "```mermaid",
      "sequenceDiagram",
      "```",
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["flow", "flow", "code"]);
    expect(blocks[0]).toMatchObject({ attrs: { title: "A" }, src: ["a --> b"] });
  });

  test("the linter names the file line of a flow mistake", () => {
    const src = "---\nkind: document\ntitle: T\n---\n\n```flow\na --> b\nb ~~ c\n```\n";
    expect(lintMarkdown(src).issues).toEqual([
      { line: 8, message: 'expected an arrow (-->, -.->, ==>, ---) after b, found "~~ c"' },
    ]);
  });

  test("in a prototype, a click to a screen that does not exist is caught", () => {
    const src =
      '---\nkind: prototype\ntitle: T\nstart: home\n---\n{#home title="Home"}\n```flow\na --> b\nclick b "#nowhere"\n```\n';
    expect(lintMarkdown(src).issues.map((i) => i.message)).toEqual([
      "no screen has the id #nowhere",
    ]);
  });
});
