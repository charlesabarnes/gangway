import {
  block,
  chart,
  choice,
  flag,
  front,
  md,
  num,
  slides,
  stat,
  str,
  type ArtifactTemplate,
} from "./kit.ts";

const pitch: ArtifactTemplate = {
  id: "deck/pitch",
  kind: "deck",
  name: "Pitch",
  description:
    "Make a case: the problem, one number that proves it, the proposal, what it costs, the ask.",
  title: "A live preview for every pull request",
  subtitle: "Review the change, not a description of it",
  options: [
    { key: "number", label: "Big-number slide", kind: "boolean", default: true },
    { key: "chart", label: "Chart beside the proposal", kind: "boolean", default: true },
    { key: "quote", label: "A reviewer's quote", kind: "boolean", default: true },
  ],
  build(s) {
    const how =
      "1. A pull request opens\n2. CI builds it\n3. A link appears on the pull request\n4. Closing it removes the preview";
    const trend = chart("line", { x: "week", y: "previews", title: "Previews a week, pilot" }, [
      ["week", "previews"],
      ...["W1", "W2", "W3", "W4", "W5", "W6"].map((w, i) => [w, [12, 31, 44, 58, 61, 66][i]!]),
    ]);
    const deck = slides(
      `# ${s.title}\n${s.subtitle}\n\nNotes: One minute. The demo comes after the ask.`,
      "## Reviews stall on setup\n- Reviewers pull the branch, install it and run it by hand\n- Designers and product managers can't do that at all\n- So most interface changes are approved **from screenshots**",
      flag(s, "number") &&
        `{layout=big}\n${stat({ label: "Median wait for a first review", value: "26 h", delta: "-40%", good: "down", note: "43 h before the pilot" })}`,
      flag(s, "chart")
        ? `{layout=split}\n## One push, one link\n${block("columns", {}, `${how}\n+++\n${trend}`)}`
        : `## One push, one link\n${how}`,
      flag(s, "quote") &&
        "{layout=quote}\n> I reviewed the checkout change on my phone, on the train, before it merged.\n>\n> — Priya, design lead",
      `## It costs two days and a server we own\n${block("stats", {}, "Setup | 2 days | | One workflow file a repository\nHosting | $0 | | Hardware we run\nUpkeep | 1 h a month | | Updates and certificates")}`,
      `{layout=statement}\n## Roll it out to three more teams this quarter.\n\nWe report review times again at the end of the quarter, and switch it off if they have not fallen.`,
      `{layout=end}\n# Questions\nThe pilot's numbers and setup notes are in the platform wiki.`,
    );
    return { markdown: md(front(s, "deck", { footer: "Platform team · September 2026" }), deck) };
  },
};

const STREAMS = [
  ["Checkout redesign", "On track", "ok", "New address form for half of users", "Everyone"],
  ["Search relevance", "At risk", "warn", "Ranking model trained", "A/B test; needs an engineer"],
  ["Mobile app 2.0", "On track", "ok", "Offline mode in beta", "App store review"],
  ["Warehouse move", "Blocked", "danger", "Schemas migrated", "Waiting on a vendor contract"],
  ["Billing export", "Done", "ok", "Shipped 12 September", "—"],
] as const;

const review: ArtifactTemplate = {
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

const talk: ArtifactTemplate = {
  id: "deck/talk",
  kind: "deck",
  name: "Talk",
  description:
    "Teach one idea in sections: a statement, a diagram, an example, a quote, what to take away.",
  title: "How a request finds your container",
  subtitle: "Hostnames, a routing table and one proxy",
  options: [
    { key: "sections", label: "Sections", kind: "number", min: 1, max: 3, default: 3 },
    { key: "code", label: "Code example", kind: "boolean", default: true },
    { key: "notes", label: "Speaker notes", kind: "boolean", default: true },
  ],
  build(s) {
    const notes = (n: string) => (flag(s, "notes") ? `\n\nNotes: ${n}` : "");
    const flow = [
      '```flow title="One request" direction=LR',
      "flowchart LR",
      "  browser([Browser]) --> proxy[Proxy]",
      "  proxy --> table{Hostname known?}",
      "  table -->|yes| app([Container])",
      "  table -->|no| missing[404 page]",
      "  class missing muted",
      "```",
    ].join("\n");
    const sections = [
      `{layout=section}\n## Names\n\n---\n\n{layout=statement}\n## Every preview is a hostname; the hostname is the whole address.${notes("Nothing else in the URL matters to routing.")}`,
      `{layout=section}\n## The table\n\n---\n\n## One lookup, then one hop\n${flow}${notes("The table lives in memory; the database is only read at boot.")}`,
      `{layout=section}\n## The proxy\n\n---\n\n## Streaming both ways\n${
        flag(s, "code")
          ? "```ts\nconst entry = table.lookup(host);\nif (!entry) return unknownPage(host);\nreturn upstream.fetch(req, entry);\n```"
          : "- The request body streams in\n- The response streams out\n- Nothing is buffered"
      }${notes("Three lines carry almost all traffic.")}`,
    ].slice(0, num(s, "sections"));
    const deck = slides(
      `# ${s.title}\n${s.subtitle}`,
      ...sections,
      "{layout=quote}\n> Make the common case a lookup, and the rare case a page that says why.\n>\n> — A design note",
      `## Take away\n- A preview is a **hostname**\n- Routing is one **in-memory lookup**\n- The proxy **streams**; it never waits for a whole body`,
      `{layout=end}\n# Thank you\nSlides and notes: the team wiki.`,
    );
    return { markdown: md(front(s, "deck", { footer: "Engineering onboarding" }), deck) };
  },
};

export const DECK_TEMPLATES = [pitch, review, talk];
