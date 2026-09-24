import {
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

const proposal: ArtifactTemplate = {
  id: "document/proposal",
  kind: "document",
  name: "One-page proposal",
  description:
    "A decision document: context, the proposal, options considered, cost, risks, the decision asked for.",
  title: "Move reviews onto preview environments",
  subtitle: "A proposal for the platform group",
  options: [
    { key: "options", label: "Options compared", kind: "boolean", default: true },
    { key: "cost", label: "Cost section", kind: "boolean", default: true },
    { key: "risks", label: "Risks section", kind: "boolean", default: true },
  ],
  build(s) {
    return {
      markdown: md(
        front(s, "document", { byline: "Author name", date: "September 2026" }),
        block(
          "callout",
          { title: "The decision we need" },
          "Approve a two-month pilot with three teams, starting next sprint.",
        ),
        "## Reviews wait a day, mostly on setup\nReviewers pull, install and run each change by hand. Designers can't review running code at all.",
        "## Every pull request gets a link\nEach PR gets a running copy at its own URL, torn down when the PR closes.",
        flag(s, "options") &&
          "## Self-hosting is the cheapest good fit\n| Option | Cost | Fit |\n|---|---|---|\n| Self-hosted previews | Low | Good |\n| Hosted vendor | High | Good |\n| Shared staging | Low | Poor |",
        flag(s, "cost") &&
          `## It costs two days of setup\n${block("stats", {}, "Setup | 2 days\nRunning cost | $0 | | Existing hardware")}`,
        flag(s, "risks") &&
          `## The risk is capacity\n${block("callout", { tone: "warn", title: "Many open PRs at once" }, "Could fill the server; idle previews sleep to limit this.")}`,
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
      "- Documents, dashboards and decks from one markdown file\n- A theme toggle on every page",
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

const releases: ArtifactTemplate = {
  id: "document/releases",
  kind: "document",
  name: "Release notes",
  description: "A changelog: one section per release with a date, a type flag and what changed.",
  title: "What's new",
  subtitle: "Release notes, newest first",
  options: [
    { key: "releases", label: "Releases", kind: "number", min: 1, max: 6, default: 4 },
    { key: "intro", label: "Intro paragraph", kind: "boolean", default: true },
  ],
  build(s) {
    return {
      markdown: md(
        front(s, "document"),
        flag(s, "intro") && "Every change that reaches users, in plain words.",
        ...CHANGES.slice(0, num(s, "releases")).map(
          (c) => `## Version ${c.v}\n:flag[${c.tag}]{tone=${c.tone}} · ${c.date}\n\n${c.notes}`,
        ),
      ),
    };
  },
};

export const DOCUMENT_TEMPLATES = [report, proposal, releases];
