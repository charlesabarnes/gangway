import {
  attrs,
  choice,
  FENCE,
  flag,
  frames,
  front,
  md,
  num,
  str,
  type ArtifactTemplate,
} from "../kit.ts";

const flowChart = (a: Record<string, string | boolean>, lines: string[]) =>
  [`${FENCE}flow ${attrs(a)}`, ...lines, FENCE].join("\n");

const VIEWS = [
  {
    id: "where",
    question: "What runs where",
    headline: "Everything runs in one region",
    text: "Everything we run sits in one AWS region, behind Cloudflare. Payments and shipping are vendors we call, never hosts we run.",
    chart: (dir: string) =>
      flowChart(
        {
          caption: "Grey lines leave our systems. Only orders-api holds a Stripe key.",
        },
        [
          `flowchart ${dir}`,
          "  shopper[Shopper<br/>web and iOS]",
          "  subgraph edge [Cloudflare]",
          "    cdn[CDN<br/>`static assets`]",
          "    waf[WAF<br/>`rate limits`]",
          "  end",
          "  subgraph aws [AWS us-east-1]",
          "    subgraph prod [Production]",
          "      web[storefront<br/>`Next.js, 6 pods`]",
          "      api[orders-api<br/>`Go :8080`]",
          "      worker[fulfilment worker<br/>`queue consumer`]",
          "    end",
          "    pg[(Postgres<br/>`RDS, multi-AZ`)]",
          "    queue[(SQS<br/>`orders queue`)]",
          "  end",
          "  subgraph vendors [Third parties]",
          "    stripe[Stripe<br/>payments]",
          "    shipbob[ShipBob<br/>fulfilment]",
          "  end",
          "  shopper -->|https| cdn --> waf --> web",
          "  web -->|REST| api -->|SQL| pg",
          "  api --> queue --> worker",
          "  api e1@-.->|card tokens| stripe",
          "  worker e2@-.-> shipbob",
          "  class prod ok",
          "  class vendors,e1,e2 muted",
          "  legend ok: our production path",
          "  legend muted dashed: calls to vendors",
        ],
      ),
  },
  {
    id: "order",
    question: "How an order goes through",
    headline: "Charged on the request, shipped from a queue",
    text: "An order is accepted as soon as the card is charged. Everything after that happens off the request, so a slow warehouse never slows checkout.",
    chart: () =>
      flowChart(
        {
          play: true,
          caption: "Press Play to walk it, or click a step for its note.",
        },
        [
          "flowchart TB",
          "  cart([Shopper pays])",
          "  reserve[Reserve stock]",
          "  charge[Charge the card]",
          "  paid{Charged?}",
          "  release[Release the stock]",
          "  enqueue[Queue the order]",
          "  ship([Warehouse ships it])",
          "  cart --> reserve --> charge --> paid",
          "  paid -->|no| release",
          "  paid -->|yes| enqueue --> ship",
          "  class release danger",
          "  class ship ok",
          "  note reserve: orders-api holds the stock for 10 minutes in Postgres.",
          "  note charge: Stripe, with the order id as the idempotency key.",
          "  note enqueue: The shopper sees the confirmation page here.",
          "  note ship: The worker retries ShipBob for up to a day.",
        ],
      ),
  },
  {
    id: "ship",
    question: "How a change reaches production",
    headline: "Every merge ships through a canary",
    text: "Every merge ships. A canary takes a twentieth of traffic first and rolls itself back if errors rise.",
    chart: (dir: string) =>
      flowChart(
        {
          caption: "No one deploys by hand; the rollback is automatic.",
        },
        [
          `flowchart ${dir}`,
          "  merge([Merge to main])",
          "  subgraph ci [GitHub Actions]",
          "    test[Tests<br/>`about 6 min`]",
          "    build[Build images]",
          "  end",
          "  subgraph stage [Staging]",
          "    staging[storefront-staging<br/>`smoke tests`]",
          "  end",
          "  subgraph prod [Production]",
          "    canary[Canary<br/>`5% of traffic`]",
          "    all[All pods]",
          "    rollback[Roll back<br/>`previous image`]",
          "  end",
          "  merge --> test --> build --> staging",
          "  staging -->|passes| canary -->|15 min clean| all",
          "  canary e1@-.->|errors up| rollback",
          "  class stage warn",
          "  class prod ok",
          "  class e1 danger",
          "  legend warn: staging",
          "  legend ok: production",
          "  legend danger dashed: automatic rollback",
        ],
      ),
  },
];

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
    const views = VIEWS.slice(0, num(s, "diagrams")).map((v) =>
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
