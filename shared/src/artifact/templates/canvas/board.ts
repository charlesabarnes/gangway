import { block, flag, frames, front, md, num, type ArtifactTemplate } from "../kit.ts";

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

export const board: ArtifactTemplate = {
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
