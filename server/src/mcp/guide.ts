/**
 * What an agent should know before its first call. Served by the MCP server itself
 * -- `instructions`, which every client loads on connect, and the `generate-artifact` prompt --
 * so Claude Code, Codex, Cursor or anything else that speaks MCP works well with nothing
 * installed. The Claude Code plugin's skill (plugin/gangway/skills/generate-artifact) says the
 * same things in its own words; a test holds the rules that matter in both.
 *
 * `instructions` is in every session's context, forever: short, rules only. The prompt is
 * fetched on purpose and may be long.
 */

export const INSTRUCTIONS = `gangway gives an app a public HTTPS URL on the user's own server. deploy blocks until the URL answers, usually in about 10 seconds -- the preview is your test environment, so write each file once and deploy it.
- A page or two: deploy with files. Bigger, or already on disk: deploy with upload: "new", run the tar | curl line it prints, then deploy with upload: "<id>". Never retype files that are on disk.
- Pass check: ["/", "/api/..."] and the answer carries each path's HTTP status, the plan gangway followed and a sha256 of every deployed file. No need to curl each route or hash files yourself.
- Fix in place: deploy with preview: "<name>" and only the changed files (or remove). Same URL; add-on data is kept.
- index.html alone is static. index.ts plus a bunfig.toml is Bun; package.json with a start script is Node. Servers listen on $PORT on 0.0.0.0. addons: ["postgres"] sets DATABASE_URL.
- Something wrong: logs with source: "runtime" shows what the app printed.
The generate-artifact prompt has the whole workflow.`;

/** The `generate-artifact` prompt: the workflow for building something artifact-sized and shipping it here. */
export function artifactPrompt(what: string | undefined): string {
  const task = what?.trim() ? `What to build: ${what.trim()}\n\n` : "";
  return `${task}Build this as you would a Claude artifact, then ship it to a real HTTPS URL with gangway's deploy tool. Treat the preview as a very fast artifact host: a deploy answers in about 10 seconds, so the slow part is always you. Write every file once, deploy it, and test the live preview.

PLAN
- Keep it the size an artifact would be unless asked for more. One strong page beats four thin ones.
- Choose the smallest runtime that works:
  - static: index.html at the root, no build.
  - Bun: index.ts plus an empty bunfig.toml. The bunfig.toml is what makes gangway choose Bun.
  - Node: package.json with a start script.
  - Python, Deno and PHP are also detected.
- A server listens on process.env.PORT (fall back to 3000) on 0.0.0.0. A Bun or Deno module may instead export default { fetch }.
- Data: addons: ["postgres"] (or redis, mysql) sets DATABASE_URL (REDIS_URL). In Bun, import { sql } from "bun" reads it. Create tables at startup with "create table if not exists".
- Streaming (SSE): with Bun.serve set idleTimeout: 0, and send an SSE comment every 15 s.

SHIP
- Up to about 30 KB of text in a few files: deploy with files directly. Don't write them to disk first.
- Bigger, or already on disk: write the files into a fresh directory, deploy with upload: "new", run the exact tar | curl command it prints from that directory, then deploy with upload: "<id>" plus name, visibility, addons and check.
- Always pass check with the paths that matter, e.g. ["/", "/api/items"]. The answer lists each path's status, the plan gangway followed (runtime, what runs, why) and every deployed file with its sha256. Read it; it replaces curling routes and guessing.
- Use visibility "unlisted" unless the user wants it public.

ITERATE AT THE SAME URL
- Fix with deploy + preview: "<name>" + only the changed files, or remove: [paths]. The add-on data is kept.
- For a large change, get a new upload and deploy with both preview and upload. That replaces the whole source.
- You may rebuild previews your user deployed. Rebuilding someone else's asks the user for the update scope; don't route around that with a copy unless they say so.

WHEN SOMETHING IS WRONG
- A deploy that answers "failed:" ends with the log. Read it before changing anything.
- logs with source: "runtime" (optionally service: "web") shows what the app printed. source: "pipeline" shows the build.
- A plan that cannot run is refused with its reasons. Add the file it names (bunfig.toml, a start script, gangway.yml) rather than guessing.

HAND OVER
- The check results and a curl or two of API routes are enough verification. Open a browser only if asked, or if the change is purely visual and can't be checked any other way.
- End with the URL, one line on what is there, and what is not done or not checked. Leave the preview running; it expires on its own, and destroy is the user's call.`;
}
