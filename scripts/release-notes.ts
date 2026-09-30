// Release notes for TAG: GitHub's generated notes (sorted by .github/release.yml), with the
// "Upgrade steps" of every upgrade-steps PR first and the gangway Unraid template changes after.
// Run by release.yml; locally: GH_TOKEN=$(gh auth token) TAG=v0.3.4 bun scripts/release-notes.ts

const REPO = process.env.GITHUB_REPOSITORY ?? "charlesabarnes/gangway";
const TEMPLATES_REPO = "charlesabarnes/unraid-templates";
const TEMPLATES = ["templates/gangway.xml", "templates/gangway-inabox.xml"];
const TAG = process.env.TAG ?? process.env.GITHUB_REF_NAME;
const TOKEN = process.env.GH_TOKEN;
if (!TAG || !TOKEN) throw new Error("TAG and GH_TOKEN are required");

async function github<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com/${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Release {
  tag_name: string;
  draft: boolean;
  published_at: string;
}
interface Pull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
}
interface Commit {
  sha: string;
  html_url: string;
  commit: { message: string; committer: { date: string } };
}

export function section(body: string, heading: string): string {
  const lines = body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const text = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  return /^(none\.?|n\/a)?$/i.test(text) ? "" : text;
}

async function main(): Promise<string> {
  const releases = await github<Release[]>(`repos/${REPO}/releases?per_page=30`);
  const previous = releases.find((r) => !r.draft && r.tag_name !== TAG);

  const generated = await github<{ body: string }>(`repos/${REPO}/releases/generate-notes`, {
    tag_name: TAG,
    ...(previous && { previous_tag_name: previous.tag_name }),
  });

  const numbers = [
    ...new Set(
      [...generated.body.matchAll(new RegExp(`github\\.com/${REPO}/pull/(\\d+)`, "g"))].map(
        (m) => m[1],
      ),
    ),
  ];
  const pulls = await Promise.all(numbers.map((n) => github<Pull>(`repos/${REPO}/pulls/${n}`)));
  const steps = pulls
    .filter((p) => p.labels.some((l) => l.name === "upgrade-steps"))
    .map((p) => ({ p, text: section(p.body ?? "", "Upgrade steps") }))
    .filter(({ text }) => text)
    .map(({ p, text }) => `### ${p.title} ([#${p.number}](${p.html_url}))\n\n${text}`);

  const since = previous ? `&since=${previous.published_at}` : "";
  const commits = (
    await Promise.all(
      TEMPLATES.map((path) =>
        github<Commit[]>(`repos/${TEMPLATES_REPO}/commits?path=${path}&per_page=100${since}`),
      ),
    )
  ).flat();
  const templates = [...new Map(commits.map((c) => [c.sha, c])).values()]
    .sort((a, b) => a.commit.committer.date.localeCompare(b.commit.committer.date))
    .map((c) => `- ${c.commit.message.split("\n")[0]} ([${c.sha.slice(0, 7)}](${c.html_url}))`);

  const parts: string[] = [];
  if (steps.length) parts.push(`## Upgrade steps\n\n${steps.join("\n\n")}`);
  parts.push(generated.body.trim());
  if (templates.length) {
    parts.push(
      `## Unraid templates\n\nChanged in [${TEMPLATES_REPO}](https://github.com/${TEMPLATES_REPO}); Community Applications picks them up on its own.\n\n${templates.join("\n")}`,
    );
  }
  return parts.join("\n\n") + "\n";
}

if (import.meta.main) process.stdout.write(await main());
