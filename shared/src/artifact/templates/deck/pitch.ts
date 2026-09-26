import { block, chart, flag, front, md, slides, stat, type ArtifactTemplate } from "../kit.ts";

export const pitch: ArtifactTemplate = {
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
