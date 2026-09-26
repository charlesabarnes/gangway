import { block, choice, flag, front, md, num, str, type ArtifactTemplate } from "./kit.ts";

/** Frames are separated like slides; each starts with its {#id …} line. */
const frames = (...parts: (string | false)[]) =>
  parts.filter((p): p is string => typeof p === "string").join("\n\n---\n\n");

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

const userFlow: ArtifactTemplate = {
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

// Three variations of a mark, drawn as inline SVG in the house palette.
const MARKS = [
  {
    id: "stacked",
    title: "A · Stacked",
    svg: '<svg viewBox="0 0 200 160"><rect x="70" y="30" width="60" height="30" fill="#f3c443"/><rect x="36" y="68" width="60" height="30" fill="#c93029"/><rect x="104" y="68" width="60" height="30" fill="currentColor"/><polygon points="20,106 180,106 160,136 40,136" fill="currentColor"/></svg>',
    note: "The current mark: three containers on a hull.",
  },
  {
    id: "single",
    title: "B · One container",
    svg: '<svg viewBox="0 0 200 160"><rect x="60" y="54" width="80" height="40" fill="#f3c443"/><polygon points="20,102 180,102 160,132 40,132" fill="currentColor"/></svg>',
    note: "Reads at 16 px; loses the idea of many previews.",
  },
  {
    id: "flag",
    title: "C · Signal flag",
    svg: '<svg viewBox="0 0 200 160"><line x1="60" y1="24" x2="60" y2="136" stroke="currentColor" stroke-width="6"/><rect x="63" y="28" width="80" height="54" fill="#f3c443"/><rect x="63" y="55" width="80" height="27" fill="#c93029"/></svg>',
    note: "A flag, as the state badges use. Drops the ship.",
  },
  {
    id: "outline",
    title: "D · Outline",
    svg: '<svg viewBox="0 0 200 160" fill="none" stroke="currentColor" stroke-width="4"><rect x="70" y="30" width="60" height="30"/><rect x="36" y="68" width="60" height="30"/><rect x="104" y="68" width="60" height="30"/><polygon points="20,106 180,106 160,136 40,136"/></svg>',
    note: "For stamps and one-colour print.",
  },
];

const board: ArtifactTemplate = {
  id: "canvas/board",
  kind: "canvas",
  name: "Board",
  description:
    "Illustrations or explorations laid side by side to compare, each with a caption, plus the brief.",
  title: "Mark explorations",
  subtitle: "Four directions for the app icon",
  options: [
    { key: "items", label: "Variations", kind: "number", min: 2, max: 4, default: 4 },
    { key: "brief", label: "The brief", kind: "boolean", default: true },
  ],
  build(s) {
    const items = MARKS.slice(0, num(s, "items")).map(
      (m) => `{#${m.id} title="${m.title}" w=360}\n${m.svg}\n\n${m.note}`,
    );
    return {
      markdown: md(
        front(s, "canvas", { layout: "grid", columns: "3", gap: "64" }),
        frames(
          flag(s, "brief") &&
            `{#brief title="Brief" frame=note w=360}\nThe icon has to read at **16 px** in a browser tab and on a phone's home screen, in light and dark.\n\n${block("facts", {}, "Due: 10 October\nOwner: Design")}`,
          ...items,
        ),
      ),
    };
  },
};

const PARTS = [
  {
    id: "edge",
    title: "Edge proxy",
    body: "Terminates TLS and routes each hostname to its preview.\n\n::: facts\nRuns: gangway\nPort: 443\n:::",
    x: 0,
    y: 0,
  },
  {
    id: "files",
    title: "File server",
    body: "Answers static sites and artifacts from disk, with no container.\n\n:flag[No container]{tone=ok}",
    x: 520,
    y: -140,
  },
  {
    id: "apps",
    title: "Preview containers",
    body: "One compose project a preview; slept when idle, woken on the next request.\n\n:flag[Sleeps after 30 min]{tone=flag}",
    x: 520,
    y: 140,
  },
  {
    id: "db",
    title: "SQLite",
    body: "Previews, routes, users and settings. The routing table is read once, at boot.",
    x: 1040,
    y: 140,
  },
];

const systemMap: ArtifactTemplate = {
  id: "canvas/map",
  kind: "canvas",
  name: "System map",
  description:
    "A system on one board: each part a frame with what it does, arrows for what talks to what.",
  title: "How a request reaches a preview",
  subtitle: "The parts of gangway a page load passes through",
  options: [
    { key: "labels", label: "Arrow labels", kind: "boolean", default: true },
    { key: "legend", label: "Legend", kind: "boolean", default: true },
  ],
  build(s) {
    const label = (t: string) => (flag(s, "labels") ? ` "${t}"` : "");
    const arrows: Record<string, string> = {
      edge: `\n-> files${label("static")}\n-> apps${label("everything else")}`,
      apps: `\n-> db${label("state")}`,
    };
    const parts = PARTS.map(
      (p) =>
        `{#${p.id} title="${p.title}" x=${p.x} y=${p.y} w=400}\n${p.body}${arrows[p.id] ?? ""}`,
    );
    return {
      markdown: md(
        front(s, "canvas"),
        frames(
          ...parts,
          flag(s, "legend") &&
            '{#legend title="Legend" frame=note x=0 y=300 w=400}\n:flag[Awake]{tone=ok} serving now\n\n:flag[Asleep]{tone=flag} wakes on a request',
        ),
      ),
    };
  },
};

export const CANVAS_TEMPLATES = [userFlow, board, systemMap];
