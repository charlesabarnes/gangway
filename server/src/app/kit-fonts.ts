import path from "node:path";
import { FONT_PATH } from "../net/page-chrome.ts";
import { renderDist } from "../previews/artifact-render.ts";

const NAME = /^[a-z0-9-]+\.woff2$/;

/** The kit's Plex fonts, for the pages gangway serves on preview hosts (waking, password, errors). */
export async function serveKitFont(req: Request, dist = renderDist()): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith(FONT_PATH) || (req.method !== "GET" && req.method !== "HEAD"))
    return null;
  const name = pathname.slice(FONT_PATH.length);
  if (!NAME.test(name)) return null;
  const file = Bun.file(path.join(dist, "fonts", name));
  if (!(await file.exists())) return null;
  return new Response(req.method === "HEAD" ? null : file, {
    headers: {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
