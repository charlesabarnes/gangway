import {
  attrs,
  block,
  choice,
  FENCE,
  flag,
  front,
  md,
  str,
  type ArtifactTemplate,
} from "../kit.ts";

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

export const processFlow: ArtifactTemplate = {
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
