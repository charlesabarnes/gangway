---
name: generate-artifact
description: Build something you would normally make as a Claude artifact (a page, an interactive demo, a mockup set, a small app, a dashboard or a game) and ship it to a real HTTPS URL on the user's gangway server. Use it when the result needs more than an artifact gives: several pages with their own URLs, a backend or API, a database, server-sent events or websockets, or a link to share and open on a phone.
argument-hint: "[what to build]"
---

# Ship an artifact-style build to gangway

Treat the gangway preview as a very fast artifact host: a deploy answers in about 10 seconds. The slow part is always you. Write every file **once**, deploy it, and use the live preview as your test environment.

What to build: $ARGUMENTS

## Plan in one breath

- Keep it the size an artifact would be unless the user asked for more. One strong page beats four thin ones.
- Choose the smallest runtime that works:
  - **static**: `index.html` at the root, no build step.
  - **bun**: `index.ts` plus an empty `bunfig.toml`. The `bunfig.toml` is what makes gangway choose Bun.
  - **node**: `package.json` with a `start` script.
  - **python**, **deno** and **php** are also detected.
- A server must listen on `process.env.PORT` (fall back to 3000) on `0.0.0.0`. A Bun or Deno module may instead `export default { fetch }`.
- Need data? Add `addons: ["postgres"]` (or `redis`, `mysql`). The URL arrives as `DATABASE_URL` or `REDIS_URL`. In Bun, `import { sql } from "bun"` reads `DATABASE_URL`. Create tables at startup with `create table if not exists`.
- With Bun's `Bun.serve`, set `idleTimeout: 0` if you stream (SSE); otherwise idle streams are cut after 10 s. Send an SSE comment every 15 s to keep proxies from closing the stream.

## Ship it

**Up to about 30 KB of text in a few files:** call the gangway MCP `deploy` tool with `files` directly, and don't write anything to disk first.

**Anything bigger, or already on disk:** use upload by reference, so the bytes are never retyped into a tool call.
1. Write the files into a fresh directory in your scratchpad with the Write tool.
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
