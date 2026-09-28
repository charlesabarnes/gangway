import {
  block,
  chart,
  choice,
  flag,
  front,
  lookOption,
  md,
  slides,
  stat,
  str,
  type ArtifactTemplate,
} from "../kit.ts";

export const pitch: ArtifactTemplate = {
  id: "deck/pitch",
  kind: "deck",
  name: "Pitch",
  description:
    "Make a case: the problem, the proof, before and after, how it works, what it costs, the ask.",
  title: "A live preview for every pull request",
  subtitle: "Review the change, not a description of it",
  options: [
    lookOption("poster"),
    choice("proof", "Proof", "number", [
      ["number", "One big number"],
      ["stats", "A row of numbers"],
      ["chart", "A chart beside the words"],
    ]),
    { key: "compare", label: "Before and after", kind: "boolean", default: true },
    { key: "quote", label: "A reviewer's quote", kind: "boolean", default: true },
  ],
  build(s) {
    const trend = chart("line", { x: "week", y: "previews", title: "Previews a week, pilot" }, [
      ["week", "previews"],
      ...["W1", "W2", "W3", "W4", "W5", "W6"].map((w, i) => [w, [12, 31, 44, 58, 61, 66][i]!]),
    ]);
    const proof = {
      number: `{layout=big}\n## Since the pilot began\n${stat({ label: "Median wait for a first review", value: "26 h", delta: "-40%", good: "down", note: "43 h before the pilot" })}`,
      stats: `{layout=stats}\n## Six weeks of the pilot\n${block("stats", {}, "First review | 26 h | -40% good | 43 h before\nReviews on a phone | 31% | +31% | none before\nReverted changes | 2 | -5 good | 7 the quarter before")}`,
      chart: `{layout=split}\n## Teams used it every week\n${block("columns", {}, `Previews grew each week of the pilot, and **nobody asked** for the old way back.\n\n- 4 teams, 38 repositories\n- 272 previews in six weeks\n+++\n${trend}`)}`,
    }[str(s, "proof") as "number" | "stats" | "chart"];
    const deck = slides(
      `# ${s.title}\n${s.subtitle}\n\nNotes: One minute. The demo comes after the ask.`,
      `{layout=statement}\n## Most interface changes are approved from screenshots.\n\nReviewers pull the branch and run it by hand, and designers can't do that at all.`,
      proof,
      flag(s, "compare") &&
        `{layout=compare}\n## What a review looks like\n${block("columns", {}, "### Today\n- Pull the branch, install, run it\n- Designers review screenshots\n- A day before anyone looks\n+++\n### With previews\n- Open a link on the pull request\n- Anyone reviews, on any device\n- The link is there in ten seconds")}`,
      `{layout=steps}\n## One push, one link\n1. **Open a pull request** CI builds the branch as it does today\n2. **A link appears** on the pull request, ten seconds later\n3. **Review it anywhere** on a laptop, a phone or a tablet\n4. **Merge or close** and the preview is removed`,
      flag(s, "quote") &&
        "{layout=quote}\n> I reviewed the checkout change on my phone, on the train, before it merged.\n>\n> — Priya, design lead",
      `{layout=stats}\n## It costs two days and a server we own\n${block("stats", {}, "Setup | 2 days | | One workflow file a repository\nHosting | $0 | | Hardware we run\nUpkeep | 1 h | | A month, for updates and certificates")}`,
      `{layout=statement}\n## Roll it out to three more teams this quarter.\n\nWe report review times again at the end of the quarter, and switch it off if they have not fallen.`,
      `{layout=end}\n# Questions\nThe pilot's numbers and setup notes are in the platform wiki.`,
    );
    return {
      markdown: md(
        front(s, "deck", { look: str(s, "look"), footer: "Platform team · September 2026" }),
        deck,
      ),
    };
  },
};
