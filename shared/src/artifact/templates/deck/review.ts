import {
  block,
  chart,
  choice,
  flag,
  front,
  lookOption,
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
    "A regular review: an agenda, the headline, the numbers, each workstream's state, the risks, the decisions needed.",
  title: "Q3 product review",
  subtitle: "Where each workstream stands, and what we need from you",
  options: [
    lookOption("classic"),
    { key: "streams", label: "Workstreams", kind: "number", min: 2, max: 5, default: 4 },
    choice("detail", "Workstreams as", "table", [
      ["table", "A table"],
      ["cards", "Cards"],
    ]),
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
    const cards = block(
      "grid",
      { columns: Math.min(3, streams.length) },
      streams
        .slice(0, 3)
        .map(([n, st, tone, done, next]) =>
          block("card", { title: n }, `:flag[${st}]{tone=${tone}}\n\n${done}. Next: ${next}.`),
        )
        .join("\n"),
      4,
    );
    const detail =
      str(s, "detail") === "cards"
        ? `{layout=cards}\n## Workstreams\n${cards}`
        : `## Workstreams\n${table}`;
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
    const risks = block(
      "grid",
      { columns: 2 },
      [
        block(
          "card",
          { title: "Search needs one more engineer" },
          ":flag[At risk]{tone=warn}\n\nWithout one, the A/B test slips to November.",
        ),
        block(
          "card",
          { title: "The warehouse contract" },
          ":flag[Blocked]{tone=danger}\n\nLegal review has taken five weeks so far.",
        ),
      ].join("\n"),
      4,
    );
    const deck = slides(
      `# ${s.title}\n${s.subtitle}`,
      `{layout=agenda}\n## Today\n1. The headline\n2. The numbers\n3. Workstreams\n4. Risks${flag(s, "decisions") ? "\n5. What we need from you" : ""}`,
      `{layout=statement}\n## Three of four workstreams are on track; the warehouse move is blocked on a contract.`,
      `{layout=stats}\n## The quarter in three numbers\n${block("stats", {}, "Checkout conversion | 5.2% | +2.1 pts | since July\nActive customers | 48.2k | +12% | on Q2\nSupport tickets | 1,140 | -18% good | on Q2")}`,
      detail,
      metrics,
      `{layout=cards}\n## Two risks to watch\n${risks}`,
      flag(s, "decisions") &&
        `{layout=steps}\n## What we need from you\n1. **An engineer for search** for six weeks, from the platform team\n2. **Escalate the contract** with legal this week\n3. **Confirm the date** for the warehouse cut-over`,
      `{layout=end}\n# Thank you\n${block("facts", {}, "Next review: 12 December\nMinutes: Product wiki, Q3 review")}`,
    );
    return {
      markdown: md(
        front(s, "deck", { look: str(s, "look"), footer: "Product team · Q3 2026" }),
        deck,
      ),
    };
  },
};
