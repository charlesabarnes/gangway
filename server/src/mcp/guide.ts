export const INSTRUCTIONS = `gangway is where you build artifacts for the user and put them on a real HTTPS URL on their own server: documents, dashboards, slide decks and clickable prototypes, in gangway's own style. A deploy answers in about 10 seconds, so the preview is your test environment.
- Start with the catalog tool (kind: document | dashboard | deck | prototype). Deploy a template with artifact: {template, title, subtitle, theme, accent, options}, then rewrite artifact.md (markdown with a few blocks) with preview: "<name>" + files. A bad file is refused with the line named.
- Give every deploy a title and an icon (+ iconColor): the user finds previews by them. preview + title/icon changes them without a rebuild.
- Pass check: ["/"] and the answer carries each path's status, the plan and a sha256 of every file.
- Only when the catalog can't express it: write an app. index.html alone is static; index.ts plus a bunfig.toml is Bun; package.json with a start script is Node. Servers listen on $PORT. Big or on-disk sources: deploy upload: "new", run the tar | curl line, then upload: "<id>".
- Something wrong: logs with source: "runtime".
The generate-artifact prompt has the whole workflow.`;

export function artifactPrompt(what: string | undefined): string {
  const task = what?.trim() ? `What to build: ${what.trim()}\n\n` : "";
  return `${task}Build this as an artifact on gangway: a document, dashboard, slide deck or clickable prototype drawn in gangway's own style at a real HTTPS URL. This is the main way to build here. A deploy answers in about 10 seconds, so the slow part is always you: deploy early and test the live preview.

ARTIFACTS FIRST
- Pick the kind: document (reading), dashboard (numbers and charts), deck (a talk), prototype (a clickable mockup).
- Call catalog with that kind. It lists the templates (each with options), every component and its props, and a complete example.
- Start from the closest template: deploy with artifact: {template, title, subtitle, theme, accent, options}, name, title, icon, iconColor, visibility and check. Then make it the user's: rewrite artifact.md (and data/*.csv) and deploy with preview: "<name>" + files.
- Put the story in the words: a title that says the finding, one idea per section or slide, numbers with units.
- gangway checks artifact.md on deploy; a 422 names the line. Fix exactly that.
- For a layout markdown can't express, write index.html with gangway's gw-* elements instead (the guide shows how).

ONLY IF THE CATALOG CAN'T EXPRESS IT: WRITE AN APP
- Keep it the size an artifact would be unless asked for more. One strong page beats four thin ones.
- Choose the smallest runtime that works:
  - static: index.html at the root, no build.
  - Bun: index.ts plus an empty bunfig.toml. The bunfig.toml is what makes gangway choose Bun.
  - Node: package.json with a start script.
  - Python, Deno and PHP are also detected.
- A server listens on process.env.PORT (fall back to 3000) on 0.0.0.0. A Bun or Deno module may instead export default { fetch }.
- Data: addons: ["postgres"] (or redis, mysql) sets DATABASE_URL (REDIS_URL). In Bun, import { sql } from "bun" reads it. Create tables at startup with "create table if not exists".
- Streaming (SSE): with Bun.serve set idleTimeout: 0, and send an SSE comment every 15 s.

SHIP AN APP
- Up to about 30 KB of text in a few files: deploy with files directly. Don't write them to disk first.
- Bigger, or already on disk: write the files into a fresh directory, deploy with upload: "new", run the exact tar | curl command it prints from that directory, then deploy with upload: "<id>" plus name, visibility, addons and check.
- Always pass check with the paths that matter, e.g. ["/", "/api/items"]. The answer lists each path's status, the plan gangway followed (runtime, what runs, why) and every deployed file with its sha256. Read it; it replaces curling routes and guessing.
- Use visibility "unlisted" unless the user wants it public.
- Always pass title (what the user calls it, e.g. "Checkout redesign") and icon + iconColor (what it is about: presentation, chart-line, shopping-cart…). gangway's list shows them; without them the user sees a bare address.

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
