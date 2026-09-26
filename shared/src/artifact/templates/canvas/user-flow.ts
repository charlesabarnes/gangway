import { choice, flag, frames, front, md, num, str, type ArtifactTemplate } from "../kit.ts";

const SCREENS = [
  {
    id: "home",
    title: "Home",
    body: ":image[Hero: this week's trips]{ratio=4:3}\n\n### Good morning, Ada\nTwo trips coming up.\n\n:steps[Plan,Book,Go]{at=1}",
    to: ["search", "Tap Plan a trip"],
  },
  {
    id: "search",
    title: "Search",
    body: "### Where to?\n::: facts\nFrom: London\nTo: Lisbon\nWhen: 3 to 7 Oct\n:::\n\n:flag[42 flights]{tone=ok}",
    to: ["results", "Search"],
  },
  {
    id: "results",
    title: "Results",
    body: "### Lisbon, 3 Oct\n| Flight | Time | Price |\n|---|---|---:|\n| TP 1363 | 07:40 | £118 |\n| BA 500 | 11:05 | £146 |\n| U2 7521 | 18:30 | £89 |",
    to: ["pay", "Choose TP 1363"],
  },
  {
    id: "pay",
    title: "Pay",
    body: ":steps[Plan,Book,Go]{at=2}\n\n::: facts total\nFlight: £118\nSeat 14A: £12\nTotal: £130\n:::",
    to: ["done", "Pay £130"],
  },
  {
    id: "done",
    title: "Booked",
    body: '::: callout tone=ok title="You\'re booked"\nTP 1363, 3 October, 07:40. Check-in opens 24 hours before.\n:::\n\n:steps[Plan,Book,Go]{at=3}',
    to: null,
  },
] as const;

export const userFlow: ArtifactTemplate = {
  id: "canvas/flow",
  kind: "canvas",
  name: "User flow",
  description:
    "A journey screen by screen, side by side, with an arrow for each step and notes where it matters.",
  title: "Booking a flight",
  subtitle: "From the home screen to a booked seat in five steps",
  options: [
    { key: "screens", label: "Screens", kind: "number", min: 3, max: 5, default: 5 },
    { key: "notes", label: "Design notes", kind: "boolean", default: true },
    choice("layout", "Layout", "row", [
      ["row", "One row"],
      ["grid", "A grid"],
    ]),
  ],
  build(s) {
    const shown = SCREENS.slice(0, num(s, "screens"));
    const ids = new Set(shown.map((x) => x.id));
    const screens = shown.map(
      (x) =>
        `{#${x.id} title="${x.title}" w=320 h=560}\n${x.body}${x.to && ids.has(x.to[0]) ? `\n-> ${x.to[0]} "${x.to[1]}"` : ""}`,
    );
    // In a row the screens sit 480 px apart (320 wide, 160 between); the notes go under two.
    const row = str(s, "layout") === "row";
    const under = (i: number) => (row && i < shown.length ? ` x=${i * 480} y=640` : "");
    const notes = flag(s, "notes") && [
      `{#note-search title="Note" frame=note w=320${under(1)}}\nThe last search is filled in. **Six of ten** testers searched the same city twice.`,
      `{#note-pay title="Open question" frame=note w=320${under(3)}}\nShow the seat map here, or after payment? Test both next sprint.`,
    ];
    return {
      markdown: md(
        front(s, "canvas", {
          layout: str(s, "layout"),
          gap: "160",
          ...(str(s, "layout") === "grid" ? { columns: "3" } : {}),
        }),
        frames(...screens, ...(notes || [])),
      ),
    };
  },
};
