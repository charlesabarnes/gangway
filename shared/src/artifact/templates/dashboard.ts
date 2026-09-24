import {
  block,
  chart,
  choice,
  csv,
  days,
  front,
  md,
  num,
  series,
  stat,
  str,
  type ArtifactTemplate,
} from "./kit.ts";

const TILES = [
  { label: "Revenue", value: 318400, format: "currency", delta: "+14.2%" },
  { label: "Orders", value: 7120, format: "number", delta: "+8.3%" },
  { label: "Average order", value: 44.72, format: "currency", delta: "+5.4%" },
  { label: "Refund rate", value: 0.021, format: "percent", delta: "-0.3 pt", good: "down" },
  { label: "New customers", value: 1840, format: "number", delta: "+21%" },
  { label: "Repeat rate", value: 0.37, format: "percent", delta: "+3 pts" },
];

const BREAKDOWN: [string, number][] = [
  ["Search", 0.38],
  ["Email", 0.23],
  ["Social", 0.16],
  ["Direct", 0.2],
  ["Referral", 0.03],
];

const kpi: ArtifactTemplate = {
  id: "dashboard/kpi",
  kind: "dashboard",
  name: "KPI overview",
  description: "Headline numbers with sparklines, a trend over time and a breakdown.",
  title: "Storefront, September",
  subtitle: "Last 30 days against the 30 before",
  options: [
    { key: "tiles", label: "Number tiles", kind: "number", min: 2, max: 6, default: 4 },
    choice("trend", "Trend chart", "area", [
      ["area", "Area"],
      ["line", "Line"],
      ["bar", "Bars"],
    ]),
    choice("breakdown", "Breakdown", "donut", [
      ["donut", "Donut"],
      ["bar", "Bars"],
      ["table", "Table"],
      ["none", "None"],
    ]),
  ],
  build(s) {
    const tiles = TILES.slice(0, num(s, "tiles")).map((t, i) =>
      stat({ ...t, trend: series(i + 11, 12, 10, 3, 0.3).join(",") }),
    );
    const revenue = series(21, 30, 9000, 2400, 110);
    const b = str(s, "breakdown");
    const breakdown =
      b === "table"
        ? block(
            "card",
            { title: "Orders by channel", span: 2 },
            `| Channel | Share |\n|---|---:|\n${BREAKDOWN.map(([c, v]) => `| ${c} | ${Math.round(v * 100)}% |`).join("\n")}`,
          )
        : b !== "none" &&
          chart(
            b,
            { x: "channel", y: "share", format: "percent", title: "Orders by channel", span: 2 },
            [["channel", "share"], ...BREAKDOWN],
          );
    return {
      markdown: md(
        front(s, "dashboard", {
          updated: "Updated hourly",
          columns: String(Math.min(4, Math.max(2, tiles.length))),
        }),
        ...tiles,
        chart(str(s, "trend"), {
          x: "day",
          y: "revenue",
          format: "currency",
          title: "Revenue has risen for three weeks",
          src: "data/daily.csv",
          span: breakdown ? 2 : "full",
        }),
        breakdown,
      ),
      data: {
        "data/daily.csv": csv(
          days(30).map((day, i) => ({ day, revenue: Math.round(revenue[i]!) })),
        ),
      },
    };
  },
};

const STEPS = [
  "Visited",
  "Viewed a product",
  "Added to cart",
  "Started checkout",
  "Paid",
  "Came back",
];

const funnel: ArtifactTemplate = {
  id: "dashboard/funnel",
  kind: "dashboard",
  name: "Funnel",
  description:
    "Where people drop off: a step-by-step funnel, conversion numbers and a weekly table.",
  title: "Checkout funnel",
  subtitle: "Visitors to paying customers, last 4 weeks",
  options: [
    { key: "steps", label: "Steps", kind: "number", min: 3, max: 6, default: 5 },
    { key: "weeks", label: "Weekly table", kind: "boolean", default: true },
  ],
  build(s) {
    const steps = STEPS.slice(0, num(s, "steps"));
    const counts = steps.map((_, i) => Math.round(48000 * Math.pow(0.46, i)));
    const last = counts[counts.length - 1]!;
    const rate = last / counts[0]!;
    const weeks = ["W36", "W37", "W38", "W39"].map((w, i) => {
      const visits = Math.round(12000 * (1 + i * 0.04));
      const paid = Math.round(visits * rate * (1 + i * 0.05));
      return `| ${w} | ${visits.toLocaleString("en-US")} | ${paid.toLocaleString("en-US")} | ${((paid / visits) * 100).toFixed(1)}% |`;
    });
    return {
      markdown: md(
        front(s, "dashboard", { columns: "3" }),
        stat({ label: steps[0], value: counts[0], format: "compact", delta: "+6%" }),
        stat({ label: steps[steps.length - 1], value: last, format: "compact", delta: "+11%" }),
        stat({
          label: "End to end",
          value: Number(rate.toFixed(4)),
          format: "percent",
          delta: "+0.2 pt",
        }),
        chart(
          "bar",
          {
            x: "step",
            y: "people",
            title: "Most people leave between cart and checkout",
            span: "full",
          },
          [["step", "people"], ...steps.map((st, i) => [st, counts[i]!])],
        ),
        s.opts["weeks"] === true &&
          block(
            "card",
            { title: "By week", span: "full" },
            `| Week | ${steps[0]} | ${steps[steps.length - 1]} | Conversion |\n|---|---:|---:|---:|\n${weeks.join("\n")}`,
          ),
      ),
    };
  },
};

const METRICS = [
  { key: "latency", title: "p95 latency (ms)", format: "number", base: 180, spread: 60 },
  { key: "errors", title: "Error rate", format: "percent", base: 0.004, spread: 0.004 },
  { key: "rps", title: "Requests per second", format: "compact", base: 2400, spread: 900 },
  { key: "cpu", title: "CPU", format: "percent", base: 0.52, spread: 0.2 },
];

const ops: ArtifactTemplate = {
  id: "dashboard/ops",
  kind: "dashboard",
  name: "Service health",
  description: "Operational metrics over time: current values up top, one chart per metric below.",
  title: "API health",
  subtitle: "Production, all regions",
  options: [
    { key: "metrics", label: "Metrics", kind: "number", min: 1, max: 4, default: 4 },
    choice("range", "Time range", "14", [
      ["7", "7 days"],
      ["14", "14 days"],
      ["30", "30 days"],
    ]),
    choice("chart", "Charts", "line", [
      ["line", "Lines"],
      ["area", "Areas"],
    ]),
  ],
  build(s) {
    const metrics = METRICS.slice(0, num(s, "metrics"));
    const n = num(s, "range");
    const values = metrics.map((m, i) => series(31 + i, n, m.base, m.spread));
    const rows = days(n).map((day, j) => ({
      day,
      ...Object.fromEntries(metrics.map((m, i) => [m.key, values[i]![j]!])),
    }));
    const tiles = metrics.map((m, i) =>
      stat({
        label: m.title,
        value: values[i]![n - 1],
        format: m.format,
        trend: values[i]!.slice(-12).join(","),
      }),
    );
    const charts = metrics.map((m) =>
      chart(str(s, "chart"), {
        x: "day",
        y: m.key,
        format: m.format,
        title: m.title,
        src: "data/metrics.csv",
        span: metrics.length === 1 ? "full" : 2,
        height: 200,
      }),
    );
    return {
      markdown: md(front(s, "dashboard", { updated: "Live", columns: "4" }), ...tiles, ...charts),
      data: { "data/metrics.csv": csv(rows) },
    };
  },
};

export const DASHBOARD_TEMPLATES = [kpi, funnel, ops];
