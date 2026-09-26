import { block, flag, front, md, type ArtifactTemplate } from "../kit.ts";

export const memo: ArtifactTemplate = {
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
