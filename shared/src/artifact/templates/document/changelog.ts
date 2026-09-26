import { flag, front, md, num, type ArtifactTemplate } from "../kit.ts";

const CHANGES = [
  {
    v: "2.4.0",
    date: "2026-09-22",
    tag: "Feature",
    tone: "ok",
    notes:
      "- Documents and decks from one markdown file\n- Themes an admin can set for every artifact",
  },
  {
    v: "2.3.2",
    date: "2026-09-15",
    tag: "Fix",
    tone: "flag",
    notes: "- Uploads from macOS no longer fail on padding\n- Faster rebuilds for static sites",
  },
  {
    v: "2.3.0",
    date: "2026-09-08",
    tag: "Feature",
    tone: "ok",
    notes: "- Password-protected previews\n- Sign in instead of a password",
  },
  {
    v: "2.2.1",
    date: "2026-09-01",
    tag: "Security",
    tone: "danger",
    notes: "- Refresh tokens reused after rotation are refused",
  },
  {
    v: "2.2.0",
    date: "2026-08-25",
    tag: "Feature",
    tone: "ok",
    notes: "- Database add-ons: Postgres, MySQL and Redis",
  },
  {
    v: "2.1.0",
    date: "2026-08-18",
    tag: "Change",
    tone: "warn",
    notes: "- Project names now include the instance",
  },
];

export const changelog: ArtifactTemplate = {
  id: "document/changelog",
  kind: "document",
  name: "Changelog",
  description:
    "Release notes, newest first: one section per release with its date, a type flag and what changed.",
  title: "What's new",
  subtitle: "Release notes, newest first",
  options: [
    { key: "releases", label: "Releases", kind: "number", min: 1, max: 6, default: 4 },
    { key: "intro", label: "Intro paragraph", kind: "boolean", default: true },
  ],
  build(s) {
    return {
      markdown: md(
        front(s, "document", { layout: "single" }),
        flag(s, "intro") &&
          "Every change that reaches users, in plain words. Security fixes are marked in red.",
        ...CHANGES.slice(0, num(s, "releases")).map(
          (c) => `## ${c.v}\n:flag[${c.tag}]{tone=${c.tone}} \`${c.date}\`\n\n${c.notes}`,
        ),
      ),
    };
  },
};
