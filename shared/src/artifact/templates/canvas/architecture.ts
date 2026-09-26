import { choice, flag, frames, front, md, num, str, type ArtifactTemplate } from "../kit.ts";
import { SYSTEM_VIEWS } from "../storefront.ts";

/** Wide frames for charts that run left to right; the order flow runs down, so it is narrow. */
const WIDTH: Record<string, number> = { where: 1200, order: 560, ship: 1200 };

export const canvasArchitecture: ArtifactTemplate = {
  id: "canvas/architecture",
  kind: "canvas",
  name: "Architecture diagrams",
  description:
    "A system on one board: a frame a question (what runs where, how a request flows, how changes ship), each a heading, a line of context and a grouped diagram.",
  title: "How the storefront is built",
  subtitle: "What runs where, how an order flows, and how a change ships",
  options: [
    { key: "diagrams", label: "Diagrams", kind: "number", min: 1, max: 3, default: 3 },
    choice("direction", "Direction", "LR", [
      ["LR", "Left to right"],
      ["TB", "Top to bottom"],
    ]),
    choice("layout", "Layout", "grid", [
      ["grid", "Two columns"],
      ["column", "One column"],
    ]),
    { key: "risks", label: "Risks note", kind: "boolean", default: true },
  ],
  build(s) {
    const dir = str(s, "direction");
    const views = SYSTEM_VIEWS.slice(0, num(s, "diagrams")).map((v) =>
      [
        `{#${v.id} title="${v.question}" w=${dir === "TB" && v.id !== "order" ? 760 : WIDTH[v.id]}}`,
        `## ${v.headline}`,
        v.text,
        "",
        v.chart(dir),
      ].join("\n"),
    );
    return {
      markdown: md(
        front(s, "canvas", { layout: str(s, "layout"), columns: "2", gap: "120" }),
        frames(
          ...views,
          flag(s, "risks") &&
            '{#risks title="What would hurt" frame=note w=560}\n**us-east-1 is a single point of failure.** A regional outage stops checkout; restoring in us-west-2 takes about four hours.\n\n**Stripe is the other hard dependency.** Without it, orders are refused rather than queued.',
        ),
      ),
    };
  },
};
