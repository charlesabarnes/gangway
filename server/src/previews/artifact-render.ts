import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactMeta } from "@gangway/shared/app-plan";
import { AppError } from "../errors.ts";
import { escapeHtml } from "../util/html.ts";

export const RENDER_PATH = "_gangway";
const DEFAULT_DIST = path.resolve(import.meta.dir, "../../../render/dist");

export type RenderAssets = { version: string; files: Record<string, string> };

const cache = new Map<string, RenderAssets>();

function walk(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(dir, r);
    return e.isFile() ? [r] : [];
  });
}

export const renderDist = () => process.env["GANGWAY_RENDER_DIST"] ?? DEFAULT_DIST;

export function renderAssets(dir = renderDist()): RenderAssets {
  const hit = cache.get(dir);
  if (hit) return hit;
  let version: string;
  try {
    version = (
      JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { version: string }
    ).version;
  } catch {
    throw new AppError(
      "internal",
      "the artifact renderer is not built (render/dist): run `bun run build:render`",
    );
  }
  const files = Object.fromEntries(
    walk(dir)
      .filter((f) => f !== "manifest.json")
      .map((f) => [`render/${f}`, path.join(dir, f)]),
  );
  const assets = { version, files };
  cache.set(dir, assets);
  return assets;
}

const THEME_SCRIPT =
  '(function(){var d=document.documentElement,t;try{t=localStorage.getItem("gw-theme")}catch(e){}' +
  't=t||d.dataset.pref;if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";' +
  "d.dataset.theme=t})()";

export const kitConfig = (brand: boolean) => `${JSON.stringify({ brand })}\n`;

/** The page an artifact.md is served in: the kit loads artifact.md and draws it. */
export function artifactIndex(meta: ArtifactMeta, version: string): string {
  const title = escapeHtml(meta.title);
  const desc = meta.description ? escapeHtml(meta.description) : "";
  const v = `?v=${version}`;
  const base = `/${RENDER_PATH}`;
  return `<!doctype html>
<html lang="en" data-pref="${meta.theme}" data-accent="${meta.accent}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${desc ? `<meta name="description" content="${desc}">\n<meta property="og:description" content="${desc}">\n` : ""}<meta property="og:title" content="${title}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="generator" content="gangway kit ${version}">
<script>${THEME_SCRIPT}</script>
<link rel="icon" href="${base}/favicon.svg" type="image/svg+xml">
<link rel="preload" href="${base}/fonts/sans-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${base}/fonts/serif-400-italic.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${base}/kit.css${v}">
<script type="module" src="${base}/kit.js${v}"></script>
</head>
<body>
<noscript><p style="padding:24px;font-family:sans-serif">${title} needs JavaScript to render.</p></noscript>
</body>
</html>
`;
}
