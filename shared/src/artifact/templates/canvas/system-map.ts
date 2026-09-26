import { flag, frames, front, md, type ArtifactTemplate } from "../kit.ts";

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

export const systemMap: ArtifactTemplate = {
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
