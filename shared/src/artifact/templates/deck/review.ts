import {
  block,
  chart,
  choice,
  flag,
  front,
  md,
  num,
  slides,
  str,
  type ArtifactTemplate,
} from "../kit.ts";

const STREAMS = [
  ["Checkout redesign", "On track", "ok", "New address form for half of users", "Everyone"],
  ["Search relevance", "At risk", "warn", "Ranking model trained", "A/B test; needs an engineer"],
  ["Mobile app 2.0", "On track", "ok", "Offline mode in beta", "App store review"],
  ["Warehouse move", "Blocked", "danger", "Schemas migrated", "Waiting on a vendor contract"],
  ["Billing export", "Done", "ok", "Shipped 12 September", "—"],
] as const;

export const review: ArtifactTemplate = {
  id: "deck/review",
  kind: "deck",
  name: "Status review",
  description:
    "A regular review: the headline, each workstream's state, the numbers, the risks, the decisions needed.",
  title: "Q3 product review",
  subtitle: "Where each workstream stands, and what we need from you",
  options: [
    { key: "streams", label: "Workstreams", kind: "number", min: 2, max: 5, default: 4 },
    choice("chart", "Metrics chart", "bar", [
      ["bar", "Bars"],
      ["line", "Line"],
      ["none", "None"],
    ]),
    { key: "decisions", label: "Decisions slide", kind: "boolean", default: true },
  ],
  build(s) {
    const streams = STREAMS.slice(0, num(s, "streams"));
    const table = [
      "| Workstream | State | Done | Next |",
      "|---|---|---|---|",
      ...streams.map(
        ([n, st, tone, done, next]) => `| ${n} | :flag[${st}]{tone=${tone}} | ${done} | ${next} |`,
      ),
    ].join("\n");
    const type = str(s, "chart");
    const metrics =
      type !== "none" &&
      `## Conversion is up two points since July\n${chart(
        type,
        { x: "month", y: "conversion", format: "percent", title: "Checkout conversion" },
        [
          ["month", "conversion"],
          ["Jun", 0.031],
          ["Jul", 0.032],
          ["Aug", 0.041],
          ["Sep", 0.052],
        ],
      )}`;
    const deck = slides(
      `# ${s.title}\n${s.subtitle}`,
      `{layout=statement}\n## Three of four workstreams are on track; the warehouse move is blocked on a contract.`,
      `## Workstreams\n${table}`,
      metrics,
      `## Two risks to watch\n${block("callout", { tone: "warn", title: "Search needs one more engineer" }, "Without one, the A/B test slips to November.")}\n\n${block("callout", { tone: "danger", title: "The warehouse contract" }, "Legal review has taken five weeks so far.")}`,
      flag(s, "decisions") &&
        `## What we need from you\n1. Move one engineer to search for six weeks\n2. Escalate the warehouse contract with legal`,
      `{layout=end}\n# Thank you\n${block("facts", {}, "Next review: 12 December\nMinutes: Product wiki, Q3 review")}`,
    );
    return { markdown: md(front(s, "deck", { footer: "Product team · Q3 2026" }), deck) };
  },
};
