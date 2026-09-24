import {
  block,
  chart,
  choice,
  flag,
  front,
  md,
  MONTHS,
  num,
  series,
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
    "Make a case: the problem, one number that proves it, the proposal, the cost, the ask.",
  title: "A live preview for every pull request",
  subtitle: "Review the change, not a description of it",
  options: [
    { key: "agenda", label: "Agenda slide", kind: "boolean", default: false },
    { key: "number", label: "Big-number slide", kind: "boolean", default: true },
    { key: "chart", label: "Chart beside the proposal", kind: "boolean", default: true },
  ],
  build(s) {
    const how =
      "1. A pull request opens\n2. CI builds it\n3. A link appears on the PR\n4. Closing the PR removes it";
    const trend = chart("line", { x: "week", y: "previews", title: "Previews a week" }, [
      ["week", "previews"],
      ...["W1", "W2", "W3", "W4", "W5"].map((w, i) => [w, [12, 31, 44, 58, 61][i]!]),
    ]);
    const deck = slides(
      `# ${s.title}\n${s.subtitle}\n\nNotes: One minute. The demo comes later.`,
      flag(s, "agenda") &&
        "## Agenda\n1. The problem\n2. What we propose\n3. What it costs\n4. The ask",
      "## Reviews stall on setup\n- Reviewers pull the branch, install and run it by hand\n- Designers and PMs can't do that at all\n- So most UI changes are approved **from screenshots**",
      flag(s, "number") &&
        `## A change waits a day for its first review\n${stat({ label: "Median wait", value: "26 h", delta: "-40%", good: "down", note: "Down from 43 h in the pilot" })}`,
      flag(s, "chart")
        ? `## One push, one link\n${block("columns", {}, `${how}\n+++\n${trend}`)}`
        : `## One push, one link\n${how}`,
      `## It costs two days and a server we own\n${block("stats", {}, "Hosting | $0 | | Hardware we own\nSetup | 2 days | | One workflow file per repo\nUpkeep | 1 h/mo | | Updates and certificates")}`,
      `## The ask\n${block("callout", { title: "Roll it out to three more teams this quarter" }, "We'll report review times again at the end of next quarter.")}`,
    );
    return { markdown: md(front(s, "deck", { footer: s.title }), deck) };
  },
};

const STREAMS = [
  {
    name: "Checkout redesign",
    state: "On track",
    tone: "ok",
    done: "New address form live for half of users",
    next: "Roll out to everyone",
  },
  {
    name: "Search relevance",
    state: "At risk",
    tone: "warn",
    done: "Ranking model trained on six months of clicks",
    next: "A/B test; needs one more engineer",
  },
  {
    name: "Mobile app 2.0",
    state: "On track",
    tone: "ok",
    done: "Offline mode in beta",
    next: "App store review",
  },
  {
    name: "Data warehouse move",
    state: "Blocked",
    tone: "danger",
    done: "Schemas migrated",
    next: "Waiting on security review since the 4th",
  },
  {
    name: "Accessibility audit",
    state: "Done",
    tone: "flag",
    done: "42 issues fixed",
    next: "Re-audit next quarter",
  },
] as const;

const status: ArtifactTemplate = {
  id: "deck/status",
  kind: "deck",
  name: "Status update",
  description: "A recurring update: headline numbers, one slide per workstream, risks, asks.",
  title: "Product status, September",
  subtitle: "What shipped, what's next, what's in the way",
  options: [
    { key: "streams", label: "Workstreams", kind: "number", min: 1, max: 5, default: 3 },
    { key: "risks", label: "Risks slide", kind: "boolean", default: true },
    choice("chart", "Progress chart", "line", [
      ["line", "Line"],
      ["bar", "Bars"],
      ["none", "None"],
    ]),
  ],
  build(s) {
    const counts = series(7, 6, 11, 6, 1).map(Math.round);
    const kind = str(s, "chart");
    const deck = slides(
      `# ${s.title}\n${s.subtitle}`,
      `## Fourteen things shipped, a quarter more than last month\n${block("stats", {}, "Shipped | 14 | +27%\nIn progress | 9\nBugs open | 31 | -18% down-good")}`,
      ...STREAMS.slice(0, num(s, "streams")).map(
        (w) =>
          `## ${w.name}\n:flag[${w.state}]{tone=${w.tone}}\n\n${block("facts", {}, `Done: ${w.done}\nNext: ${w.next}`)}`,
      ),
      kind !== "none" &&
        `## Delivery has grown every month\n${chart(kind, { x: "month", y: "items", title: "Items delivered", height: 380 }, [["month", "items"], ...MONTHS.slice(3, 9).map((m, i) => [m, counts[i]!])])}`,
      flag(s, "risks") &&
        `## Risks\n${block("callout", { tone: "warn", title: "Vendor contract ends in November" }, "Renewal terms are not agreed yet.")}\n\n${block("callout", { tone: "danger", title: "The warehouse move is blocked" }, "Waiting on security review since the 4th.")}`,
      "## Asks\n1. A decision on pricing by the 15th\n2. One more engineer for search",
    );
    return { markdown: md(front(s, "deck", { footer: s.title }), deck) };
  },
};

const PARTS = [
  {
    title: "What it is",
    body: "A **preview** is a running copy of a change, at its own URL, for as long as the change is open.",
  },
  {
    title: "How it works",
    body: "CI builds an image, the server runs it, and a proxy gives it a hostname.",
  },
  {
    title: "When to use it",
    body: "Anything a reviewer should *see*: UI, copy, flows, a demo for a customer.",
  },
  {
    title: "What it costs",
    body: "Memory while it runs, disk for the image. Idle previews sleep and wake on the next visit.",
  },
  {
    title: "Common mistakes",
    body: "Hard-coded hostnames, secrets in the image, and servers that listen on localhost only.",
  },
];

const lesson: ArtifactTemplate = {
  id: "deck/lesson",
  kind: "deck",
  name: "Lesson",
  description:
    "Teach one idea in parts: a section slide and an explanation per part, then a recap.",
  title: "Preview environments, explained",
  subtitle: "A 15-minute introduction",
  options: [
    { key: "parts", label: "Parts", kind: "number", min: 2, max: 5, default: 3 },
    { key: "code", label: "Code example", kind: "boolean", default: true },
    { key: "quote", label: "Quote slide", kind: "boolean", default: false },
  ],
  build(s) {
    const parts = PARTS.slice(0, num(s, "parts"));
    const deck = slides(
      `# ${s.title}\n${s.subtitle}`,
      `## What we'll cover\n${parts.map((p, i) => `${i + 1}. ${p.title}`).join("\n")}`,
      ...parts.flatMap((p, i) => [`# ${p.title}\nPart ${i + 1}`, `## ${p.title}\n${p.body}`]),
      flag(s, "code") &&
        "## Try it\n```sh\ngit switch -c my-change\ngit push -u origin my-change\n# open a pull request: the link appears on it\n```",
      flag(s, "quote") &&
        "## In their words\n> I stopped asking for screenshots.\n>\n> — A product designer",
      `## Recap\n${block("callout", { title: "Remember" }, parts.map((p) => `- ${p.title}`).join("\n"))}`,
    );
    return { markdown: md(front(s, "deck", { footer: s.title }), deck) };
  },
};

export const DECK_TEMPLATES = [pitch, status, lesson];
