---
name: deploy-once
description: Deploy the app in the current directory or repository to a gangway URL once, as it is on disk, with no CI or workflow; redeploy to the same URL later. Use when the user asks to put this repo or app up on gangway, to share a running copy, or to try it on a real URL. For a preview of every pull request, use setup-pr-previews instead.
argument-hint: "[name, or what to deploy]"
---

# Deploy this app to gangway, once

Notes from the user: $ARGUMENTS (if empty or unexpanded, there are none)

The result: the app in this directory running at a gangway URL, deployed from the files on disk (committed or not), without touching the repository. Nothing is committed, pushed or added to CI.

## 1. Find the app and how it runs

Work from the app's directory: the repository root, or the package the user named in a monorepo.

gangway picks the runtime from the files, the same rules as for any upload:

- `Dockerfile` or `compose.yaml` at the root: used as-is.
- `index.html` alone: static, served by gangway itself.
- `package.json` with a `start` script: Node. `index.ts` plus a `bunfig.toml`: Bun. Python, Deno and PHP are detected too.
- A plan that cannot run is refused with its reasons. Add the file it names (a `bunfig.toml`, a `start` script, a `gangway.yml`) rather than guessing.

Check before you send it:

- **The port:** the server must listen on `$PORT` on `0.0.0.0`. If it hard-codes `localhost` or a port, say so; don't rewrite the user's code without asking.
- **Data:** if the code reads `DATABASE_URL` or `REDIS_URL`, pass `addons: ["postgres"]` (or `redis`, `mysql`); gangway sets those variables. It is a throwaway database: migrations and seeds must run at startup, or the app starts empty.
- **Secrets:** `.env` files are not in the upload (below). Never `cat` or read one: its values would pass through the conversation. If the app needs secrets (API keys, a hosted database's URL), send them as the preview's own:
  - **From a file** (the usual case): call the `secrets` tool with just `upload: "new"` (no target yet: the preview does not exist). Run the `curl … --data-binary @.env` line it prints, from the directory with the file; gangway answers with the names only. Then deploy with `secretsUpload: "<id>"`.
  - **Values the user typed to you:** deploy with `secrets: {NAME: "value"}`.
  - They are stored on the preview, merged over the project's and the org's, kept across rebuilds, and masked in its logs.
  - If the repository is already a gangway project, `project: "<slug>"` also applies that project's secrets.
  - **"lacks the previews.secrets permission":** the connection lacks the `secrets` scope. Ask the user to run `/mcp`, re-authenticate gangway and tick "secrets" (where it may set them: previews it deploys is enough here). Otherwise deploy without them only if the app still starts, and say what is missing.

## 2. Upload the files git would ship

Call `deploy` with `upload: "new"`. It answers with a one-use URL.

In a git repository, send exactly the tracked and untracked-but-not-ignored files, so `.env`, `node_modules` and build output stay behind. From the app's directory:

```sh
git ls-files -z --cached --others --exclude-standard \
  | COPYFILE_DISABLE=1 tar --null -T - -czf - \
  | curl -sS --fail-with-body -X PUT -H 'content-type: application/gzip' --data-binary @- '<upload URL>'
```

- On macOS, add `--no-mac-metadata` after `tar`. Otherwise `._*` files ride along and can break the build.
- If `tar` says a file does not exist, it was deleted but not committed. Tell the user, or leave it out.
- Outside git: run the exact `tar … | curl` command `deploy` printed. It skips `.git` and `node_modules` but not `.env`, so remove secrets from the directory first or ask.

## 3. Deploy

Call `deploy` with `upload: "<the id>"` and:

- `name`: the repository or app name, e.g. `shop-front`. It becomes the hostname.
- `title`: what the user calls it, e.g. "Shop front". `icon` + `iconColor`: what it is about.
- `check`: the paths that matter, e.g. `["/", "/api/health"]`.
- `addons`, `project` and `secretsUpload` (or `secrets`) if step 1 found them.
- `domain`, only if the user names one of the server's domains (the `domains` tool lists them). For their own hostname, like `www.example.com`, deploy first, then `domains` with `target: {preview: "<name>"}` and `claim`; it answers with the DNS records to add.

Leave `visibility` out: the server's setting decides. Pass it only when the user asks for public, unlisted or private. The same goes for `ttl`: the server's default applies unless the user says how long.

Read the answer: each checked path's status, the plan gangway followed (runtime, what runs, and why), and every deployed file with its sha256. Check that no `.env` is in the list.

## 4. When something is wrong

- `failed:` ends with the log: read it before changing anything.
- `logs` with `source: "runtime"` shows what the app printed: a stack trace, a missing env var, the port it bound to. `source: "pipeline"` shows the build.
- Fix the cause, then redeploy to the same URL (below). Ask before changing the user's code; a missing `start` script or `bunfig.toml` is fine to suggest.

## 5. Redeploy later

- The same URL, the whole tree again: a new `upload: "new"`, the same `tar | curl`, then `deploy` with `preview: "<name>"` and `upload: "<new id>"`. Add-on data and the preview's secrets are kept.
- A changed or new secret: `deploy` with `preview: "<name>"` and `secrets` (or `secretsUpload`); `unsetSecrets: [NAME]` removes one. The rebuild applies them.
- One or two small text files: `deploy` with `preview: "<name>"` and just those `files`.

## 6. Hand over

The URL, one line on what is running (the plan), what the checks returned, and what you did not check (no secrets, an empty database…). Leave it running: it expires on its own, and `destroy` is the user's call.

- A URL under `.localhost` (or one the user's audience cannot reach) opens only on their machine. To show it to someone else, offer the `share` tool's public link and start it on yes: `share` with `preview: "<name>"` and `action: "start"` returns an `https://….trycloudflare.com` URL until it expires or `action: "stop"`. It is a Cloudflare quick tunnel: public to anyone with the link, no server-sent events.
