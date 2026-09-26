import {
  attrs,
  block,
  chart,
  choice,
  csv,
  flag,
  front,
  md,
  num,
  series,
  str,
  type ArtifactTemplate,
} from "./kit.ts";

const FINDINGS = [
  {
    title: "Three steps took two thirds of the time",
    text: "We timed every step of 2,000 builds:\n\n- **Installing dependencies**, from scratch, on every run\n- **One long test job** that waited for the build\n- **Image builds** for services the change did not touch",
  },
  {
    title: "Three changes, each under a week",
    text: "We cached the dependency store, split the tests four ways and built only the images a change touched.",
  },
  {
    title: "Builds take 6 minutes instead of 14",
    text: "Median build time fell from **14 minutes to 6**. Runner cost fell by a third.",
  },
  {
    title: "Next: a budget of 8 minutes",
    text: "1. Move slow integration tests to a nightly run\n2. Share the cache between branches\n3. Warn when a change breaks the **8-minute** budget",
  },
];

const CHANGES_TABLE =
  "| Change | Minutes saved | Effort |\n|---|---:|---|\n| Cache the dependency store | 3.8 | A day |\n| Split tests four ways | 2.9 | Two days |\n| Build only changed images | 1.4 | A week |";

const report: ArtifactTemplate = {
  id: "document/report",
  kind: "document",
  name: "Report",
  description:
    "Findings with evidence: a summary, headline numbers, sections with a chart and a table.",
  title: "How we halved build times",
  subtitle: "What slowed CI down, what we changed, and what it bought us",
  options: [
    { key: "sections", label: "Sections", kind: "number", min: 1, max: 4, default: 3 },
    choice("chart", "Chart", "bar", [
      ["bar", "Stacked bars"],
      ["line", "Line"],
      ["area", "Area"],
    ]),
    { key: "table", label: "Table", kind: "boolean", default: true },
  ],
  build(s) {
    const weeks = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"];
    const install = series(3, 8, 4.6, 0.4).map((v, i) => (i < 4 ? v : Math.round(v * 18) / 100));
    const tests = series(5, 8, 5.9, 0.4).map((v, i) => (i < 5 ? v : Math.round(v * 50) / 100));
    const rows = weeks.map((week, i) => ({
      week,
      install: install[i]!,
      tests: tests[i]!,
      total: Math.round((install[i]! + tests[i]!) * 10) / 10,
    }));
    const type = str(s, "chart");
    const stacked = type === "bar";
    const plot = chart(type, {
      x: "week",
      y: stacked ? "install,tests" : "total",
      stacked,
      labels: "install:Install,tests:Tests,total:Minutes",
      title: "Minutes per build, by week",
      src: "data/weekly.csv",
      caption: "Median of each week's builds. The changes landed in weeks 5 and 6.",
    });
    const sections = FINDINGS.slice(0, num(s, "sections")).map((f, i) =>
      [`## ${f.title}`, f.text, i === 0 && plot, i === 1 && flag(s, "table") && CHANGES_TABLE]
        .filter(Boolean)
        .join("\n\n"),
    );
    return {
      markdown: md(
        front(s, "document", { byline: "Platform team", date: "September 2026" }),
        block(
          "callout",
          { title: "In short" },
          "Median build time fell from **14 minutes to 6** after three changes, and runner cost fell by a third.",
        ),
        block(
          "stats",
          {},
          "Median build | 6 min | -57% down-good\nBuilds a day | 412 | +21%\nRunner cost | $1,840 | -34% down-good",
        ),
        ...sections,
      ),
      data: { "data/weekly.csv": csv(rows) },
    };
  },
};

const memo: ArtifactTemplate = {
  id: "document/memo",
  kind: "document",
  name: "Decision memo",
  description:
    "A decision on one page: what is asked, why now, the options weighed, the cost, the risks.",
  title: "Move reviews onto preview environments",
  subtitle: "A two-month pilot for three teams, starting next sprint",
  options: [
    { key: "options", label: "Options compared", kind: "boolean", default: true },
    { key: "cost", label: "Cost", kind: "boolean", default: true },
    { key: "risks", label: "Risks", kind: "boolean", default: true },
  ],
  build(s) {
    return {
      markdown: md(
        front(s, "document", { byline: "Platform team", date: "September 2026" }),
        block(
          "callout",
          { title: "The decision we need" },
          "Approve a two-month pilot with the checkout, search and mobile teams, starting 6 October.",
        ),
        block(
          "facts",
          {},
          "Asked of: Engineering leads\nDecide by: 3 October\nOwner: Platform team\nStatus: :flag[Awaiting decision]{tone=flag}",
        ),
        "## Reviews wait a day, mostly on setup\nA reviewer pulls the branch, installs it and runs it by hand before they can look at the change. Designers and product managers cannot do that at all, so most interface changes are approved from screenshots.\n\nThe median pull request waits **26 hours** for its first review.",
        "## Every pull request gets a link\nEach pull request gets a running copy at its own address, built by CI and torn down when the pull request closes. Reviewers open a link instead of a terminal.",
        flag(s, "options") &&
          "## Self-hosting is the cheapest good fit\n| Option | Cost a month | Setup | Fit |\n|---|---:|---|---|\n| Self-hosted previews | $0 | 2 days | Good |\n| A hosted vendor | $1,200 | 1 day | Good |\n| A shared staging server | $0 | None | Poor: one change at a time |",
        flag(s, "cost") &&
          `## It costs two days and a server we own\n${block("stats", {}, "Setup | 2 days | | One workflow file per repository\nHosting | $0 | | Hardware we already run\nUpkeep | 1 h a month | | Updates and certificates")}`,
        flag(s, "risks") &&
          `## The risk is capacity, and it is bounded\n${block("callout", { tone: "warn", title: "Many open pull requests at once" }, "Forty running previews would fill the server. Idle previews sleep after 30 minutes, and each team is capped at ten.")}\n\nIf the pilot misses its goal, we switch it off: nothing in the repositories depends on it.`,
      ),
    };
  },
};

const CHANGES = [
  {
    v: "2.4.0",
    date: "2026-09-22",
    tag: "Feature",
    tone: "ok",
    notes:
      "- Documents and decks from one markdown file\n- Themes an admin can set for every artifact",
  },
  {
    v: "2.3.2",
    date: "2026-09-15",
    tag: "Fix",
    tone: "flag",
    notes: "- Uploads from macOS no longer fail on padding\n- Faster rebuilds for static sites",
  },
  {
    v: "2.3.0",
    date: "2026-09-08",
    tag: "Feature",
    tone: "ok",
    notes: "- Password-protected previews\n- Sign in instead of a password",
  },
  {
    v: "2.2.1",
    date: "2026-09-01",
    tag: "Security",
    tone: "danger",
    notes: "- Refresh tokens reused after rotation are refused",
  },
  {
    v: "2.2.0",
    date: "2026-08-25",
    tag: "Feature",
    tone: "ok",
    notes: "- Database add-ons: Postgres, MySQL and Redis",
  },
  {
    v: "2.1.0",
    date: "2026-08-18",
    tag: "Change",
    tone: "warn",
    notes: "- Project names now include the instance",
  },
];

const changelog: ArtifactTemplate = {
  id: "document/changelog",
  kind: "document",
  name: "Changelog",
  description:
    "Release notes, newest first: one section per release with its date, a type flag and what changed.",
  title: "What's new",
  subtitle: "Release notes, newest first",
  options: [
    { key: "releases", label: "Releases", kind: "number", min: 1, max: 6, default: 4 },
    { key: "intro", label: "Intro paragraph", kind: "boolean", default: true },
  ],
  build(s) {
    return {
      markdown: md(
        front(s, "document", { layout: "single" }),
        flag(s, "intro") &&
          "Every change that reaches users, in plain words. Security fixes are marked in red.",
        ...CHANGES.slice(0, num(s, "releases")).map(
          (c) => `## ${c.v}\n:flag[${c.tag}]{tone=${c.tone}} \`${c.date}\`\n\n${c.notes}`,
        ),
      ),
    };
  },
};

const PROCESS_STEPS = [
  [
    "report",
    "([Customer reports it])",
    "Support opens a ticket with what the customer saw and when.",
  ],
  [
    "triage",
    "{Is checkout down?}",
    "The on-call engineer checks the checkout dashboard within 5 minutes.",
  ],
  ["page", "[Page the payments lead]", "Paged by phone, not chat. They own the call from here."],
  ["queue", "[Queue for the next sprint]", "Most reports are single-customer issues."],
  ["fix", "[Roll back or hotfix]", "Roll back first when the last deploy is the suspect."],
  [
    "verify",
    "{Orders flowing again?}",
    "Watch orders per minute for 15 minutes before standing down.",
  ],
  ["review", "([Write the review])", "Within two working days, blameless, with the timeline."],
] as const;

const FENCE = "```";

const processFlow: ArtifactTemplate = {
  id: "document/process",
  kind: "document",
  name: "Process explainer",
  description:
    "A process as an animated flowchart readers can step through, with a note on each step and the rules in prose.",
  title: "What happens when checkout breaks",
  subtitle: "From the first report to the written review",
  options: [
    choice("direction", "Direction", "TB", [
      ["TB", "Top to bottom"],
      ["LR", "Left to right"],
    ]),
    { key: "play", label: "Play button", kind: "boolean", default: true },
    { key: "animate", label: "Flowing edges", kind: "boolean", default: false },
  ],
  build(s) {
    const flow = [
      `${FENCE}flow ${attrs({ title: "Checkout incident", play: flag(s, "play"), animate: flag(s, "animate"), caption: flag(s, "play") ? "Press Play to walk it, or click a step for its note." : "Click a step for its note." })}`,
      `flowchart ${str(s, "direction")}`,
      ...PROCESS_STEPS.map(([id, shape]) => `  ${id}${shape}`),
      "  report --> triage",
      "  triage -->|yes| page",
      "  triage -->|no| queue",
      "  page --> fix --> verify",
      "  verify -->|no| fix",
      "  verify -->|yes| review",
      "  class page danger",
      "  class queue muted",
      "  class review ok",
      ...PROCESS_STEPS.map(([id, , note]) => `  note ${id}: ${note}`),
      FENCE,
    ].join("\n");
    return {
      markdown: md(
        front(s, "document", { byline: "Payments team", date: "September 2026" }),
        block(
          "callout",
          { title: "In short" },
          "Anyone can start this. The payments lead owns it once paged, and rolls back before debugging.",
        ),
        "## The path from report to review",
        flow,
        "## Rules that hold at every step",
        "- **Roll back before you debug.** A working checkout matters more than knowing why.\n- **One channel.** Updates go to #incident-checkout, nowhere else.\n- **Write it down as you go.** The timeline is the review's first draft.",
      ),
    };
  },
};

export const DOCUMENT_TEMPLATES = [report, memo, changelog, processFlow];
