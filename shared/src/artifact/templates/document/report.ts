import { must } from "../../../must.ts";
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
} from "../kit.ts";

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

export const report: ArtifactTemplate = {
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
    const rows = weeks.map((week, i) => {
      const a = must(install[i], "an install time");
      const b = must(tests[i], "a test time");
      return { week, install: a, tests: b, total: Math.round((a + b) * 10) / 10 };
    });
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
