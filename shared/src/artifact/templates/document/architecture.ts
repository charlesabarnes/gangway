import { block, choice, flag, front, md, num, str, type ArtifactTemplate } from "../kit.ts";
import { SYSTEM_VIEWS } from "../storefront.ts";

const COMPONENTS_TABLE =
  "| Component | Runs on | Owner | Talks to |\n|---|---|---|---|\n| storefront | EKS, 6 pods | Web team | orders-api |\n| orders-api | EKS, 4 pods | Payments team | Postgres, SQS, Stripe |\n| fulfilment worker | EKS, 2 pods | Operations | SQS, ShipBob |\n| Postgres | RDS, multi-AZ | Platform team | |\n| SQS | Managed | Platform team | |";

export const architecture: ArtifactTemplate = {
  id: "document/architecture",
  kind: "document",
  name: "Architecture overview",
  description:
    "A system explained: what runs where, how a request flows and how changes ship, as grouped diagrams, with the components, decisions and risks.",
  title: "How the storefront is built",
  subtitle: "What runs where, how an order flows, and how a change ships",
  options: [
    { key: "diagrams", label: "Diagrams", kind: "number", min: 1, max: 3, default: 3 },
    choice("direction", "Direction", "LR", [
      ["LR", "Left to right"],
      ["TB", "Top to bottom"],
    ]),
    { key: "components", label: "Components table", kind: "boolean", default: true },
    { key: "decisions", label: "Decisions", kind: "boolean", default: true },
    { key: "risks", label: "Risks", kind: "boolean", default: true },
  ],
  build(s) {
    return {
      markdown: md(
        front(s, "document", { byline: "Platform team", date: "September 2026" }),
        block(
          "callout",
          { title: "In short" },
          "Three services in one AWS region, behind Cloudflare. Orders are charged on the request and fulfilled from a queue.",
        ),
        block(
          "facts",
          {},
          "Owner: Platform team\nRegion: AWS us-east-1\nLast reviewed: September 2026\nStatus: :flag[Current]{tone=ok}",
        ),
        ...SYSTEM_VIEWS.slice(0, num(s, "diagrams")).map((v) =>
          md(`## ${v.question}`, v.text, v.chart(str(s, "direction"), v.chartTitle)).trimEnd(),
        ),
        flag(s, "components") && `## Each part has one owner\n${COMPONENTS_TABLE}`,
        flag(s, "decisions") &&
          "## Choices we would make again\n- **One region.** A second would double the bill for an outage we have not had. Backups are copied to us-west-2.\n- **A queue after payment.** Checkout never waits on the warehouse, and a ShipBob outage only delays shipping.\n- **Postgres for stock.** Reservations need transactions; a cache in front would give away stock twice.",
        flag(s, "risks") &&
          `## What would hurt\n${block("callout", { tone: "warn", title: "us-east-1 is a single point of failure" }, "A regional outage stops checkout. Restoring in us-west-2 from backups takes about four hours.")}\n\nStripe is the other hard dependency: without it, orders are refused rather than queued.`,
      ),
    };
  },
};
