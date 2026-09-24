---
name: generate-artifact
description: Build an artifact on the user's gangway server -- a document, a dashboard, a slide deck or a clickable prototype, from gangway's templates and in its style -- and share it at a real HTTPS URL. Also for pages, demos and small apps (with a backend, a database, SSE or websockets) when the templates can't express them. Use it whenever the user wants something to read, present, click through or share as a link.
argument-hint: "[what to build]"
---

# Build an artifact on gangway

gangway is the main place to build artifacts: a deploy answers in about 10 seconds, so the live preview is your test environment and the slow part is always you.

What to build: $ARGUMENTS (if that is empty or unexpanded, the user's request)

## Artifacts first

1. Pick the kind: **document** (reading), **dashboard** (numbers and charts), **deck** (a talk), **prototype** (a clickable mockup).
2. Call the MCP `catalog` tool with that kind. It returns the artifact.md guide, the templates for that kind (each with options) and a complete example. The same guide is in [catalog.md](catalog.md).
3. Start from the closest template: `deploy` with `artifact: {template, title, subtitle, theme, accent, options}`, plus `name`, `visibility` and `check`.
4. Make it the user's: rewrite `artifact.md` (markdown, plus a few blocks for stats, charts and slides; see [catalog.md](catalog.md)) and `data/*.csv` for rows, then `deploy` with `preview: "<name>"` + `files`. gangway checks it on deploy; a 422 names the line, so fix exactly that.
5. For a layout markdown can't express, write `index.html` with gangway's `gw-*` elements instead.

Put the story in the words: a title that says the finding, one idea per section or slide, numbers with units.

## Only if the catalog can't express it: write an app

- Keep it the size an artifact would be unless the user asked for more. One strong page beats four thin ones.
- Choose the smallest runtime that works:
  - **static**: `index.html` at the root, no build step.
  - **bun**: `index.ts` plus an empty `bunfig.toml`. The `bunfig.toml` is what makes gangway choose Bun.
  - **node**: `package.json` with a `start` script.
  - **python**, **deno** and **php** are also detected.
- A server must listen on `process.env.PORT` (fall back to 3000) on `0.0.0.0`. A Bun or Deno module may instead `export default { fetch }`.
- Need data? Add `addons: ["postgres"]` (or `redis`, `mysql`). The URL arrives as `DATABASE_URL` or `REDIS_URL`. In Bun, `import { sql } from "bun"` reads `DATABASE_URL`. Create tables at startup with `create table if not exists`.
- With Bun's `Bun.serve`, set `idleTimeout: 0` if you stream (SSE); otherwise idle streams are cut after 10 s. Send an SSE comment every 15 s to keep proxies from closing the stream.

## Ship an app

**Up to about 30 KB of text in a few files:** call the gangway MCP `deploy` tool with `files` directly, and don't write anything to disk first.

**Anything bigger, or already on disk:** use upload by reference, so the bytes are never retyped into a tool call.

1. Write the files into a fresh scratch directory.
2. Call `deploy` with `upload: "new"`. It answers with a one-use URL and the exact command to fill it.
3. Run that command from the app's directory. It is `tar … | curl -X PUT … --data-binary @-`.
4. Call `deploy` with `upload: "<id>"` plus `name`, `visibility`, `addons` and `check`.

**Always** pass `check` with the paths that matter, for example `["/", "/api/items"]`. The answer then includes:

- each path's HTTP status;
- the plan gangway followed (runtime, what runs, add-ons, and why);
- every deployed file with its sha256.

Read the answer; it replaces curling routes and reading gangway's source. Choose `visibility: "unlisted"` unless the user wants it public.

## Iterate at the same URL

- Fix with `deploy` + `preview: "<name>"` + only the changed `files`, or `remove: [paths]`. The add-on data is kept.
- For a large change, get a new upload and call `deploy` with both `preview` and `upload`. That replaces the whole source.
- Your credential can rebuild previews its user deployed. Rebuilding someone else's preview asks the user for the `update` scope, so don't route around that by deploying a copy unless they say so.

## When something is wrong

- `deploy` answers `failed:` with the end of the log. Read it before changing anything.
- Call `logs` with `source: "runtime"` (optionally `service: "web"`) to see what the app printed: a stack trace, a missing env var, the port it bound to. `source: "pipeline"` shows the build.
- A plan that cannot run is refused with its reasons. Add the file it names (a `bunfig.toml`, a `start` script, a `gangway.yml`) rather than guessing.

## Verify lightly, then hand over

- The `check` results and a `curl` or two of API routes are enough. Open a browser only when the user asks, or when the change is purely visual and can't be checked any other way.
- Finish with the URL, one line on what is there, and what is not done or not checked. Leave the preview running. It expires on its own, and `destroy` is the user's call.
