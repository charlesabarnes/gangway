---
name: setup-pr-previews
description: Set up gangway pull-request previews for the GitHub repository in the current directory, so every PR gets its own URL on the user's gangway server. Connects the repo to gangway with the MCP project tool, adds a Dockerfile if the repo has none, commits the generated GitHub Actions workflow on a branch and opens a PR that proves it works. Use when the user asks for PR previews, preview deployments or review apps on gangway for a repo.
argument-hint: "[port, or anything to know about the app]"
---

# Set up PR previews for this repository

Notes from the user: $ARGUMENTS (if empty or unexpanded, there are none)

The result: a pull request in this repository that adds `.github/workflows/gangway-preview.yml` (and a `Dockerfile` if needed). Its own run deploys the first preview. Once it is merged, every pull request gets a preview at `<slug>-pr-<n>` and a comment with the URL, torn down when the PR closes.

How it works, so you can explain it: the workflow builds the repository's `Dockerfile` on GitHub's runners and pushes the image to `ghcr.io`. It then asks gangway to run it, authenticated by GitHub's OIDC token for that run. No secret is stored in the repository.

## 1. Check the repository

- `git rev-parse --show-toplevel`, then work from that root.
- `gh repo view --json nameWithOwner,defaultBranchRef,isPrivate`. If this is not a GitHub repository, or `gh` is not signed in, say so and stop: the workflow only runs on GitHub.
- `git status --short`. The user's uncommitted changes are theirs: never commit, stash or discard them. Add only the files you write.
- If `.github/workflows/gangway-preview.yml` already exists, the repo may already be set up. Continue: the project tool finds the existing project, and you replace the file with the version it returns.

## 2. Make sure there is one image to build

The workflow builds the `Dockerfile` at the repository root and runs one container on one port.

- **A `Dockerfile` exists:** use it. The port is its `EXPOSE`, or where the app listens. Check that the app listens on `0.0.0.0`, not `localhost`.
- **No `Dockerfile`:** write the smallest one that builds and starts the app, from what the repository is:
  - Node: `package.json` with a `build` and a `start` script.
  - Bun: `bun.lock`, `bunfig.toml`.
  - Python: `pyproject.toml`, `requirements.txt`.
  - Go: `go.mod`.
  - Static: an `index.html`, or a build that emits one; serve it with nginx.

  Pin the base image's major version. Set `ENV PORT=<port>` and `EXPOSE <port>`, and have the app listen on `$PORT` if it reads it. Keep it close to how the repository already runs in production, if it says how. Add a `.dockerignore` (`node_modules`, `.git`, `.env*`) if there is none. Show the user the Dockerfile before you commit it.

- **Only a compose file with several services** (app + database + worker…): the workflow runs one image, so say so and stop. Tell the user the gangway GitHub App (Repositories, in gangway's UI) builds compose stacks from the PR instead.
- **The app needs a database:** it will not have one in the preview. Say so in the handover. Runtime secrets such as a hosted database's URL go on the project (step 3b).

## 3. Connect the repository

Call the gangway MCP `project` tool with `repository` (`owner/name` from step 1) and `port`.

- It finds or creates the gangway project and answers with the workflow file after `--- .github/workflows/gangway-preview.yml`. Write that text **verbatim** to the path; don't edit or reformat it.
- **"refused: … lacks the repos.manage permission":** the connection lacks the `projects` scope. Tell the user to run `/mcp`, re-authenticate gangway, and tick "projects" on the consent page, then call the tool again. If they are not allowed that scope, a gangway admin must connect the repository in the UI (Repositories).
- **"slug … is taken":** call it again with a `slug` of your choosing, e.g. `<owner>-<name>`, at most 24 characters.
- **"the GitHub App already previews":** nothing to add. Tell the user and stop.
- **"disabled":** carry on, but tell the user it must be enabled in gangway before previews deploy.

## 3b. Runtime secrets, if the app needs them

Secrets every PR preview needs go on the project; gangway adds them when a PR deploys. Use the `secrets` tool:

- From the user's `.env` (never read it yourself): `secrets` with `target: {project: "<slug>"}` and `upload: "new"`, run the `curl … --data-binary @.env` line it prints, then `secrets` with the same target and `upload: "<id>"`. Only names come back.
- Values the user typed to you: `secrets` with `target: {project: "<slug>"}` and `set`.
- One PR's own value (e.g. a feature flag): `target: {preview: "<slug>-pr-<n>"}`; it is kept across that PR's pushes.
- "may not set secrets on project": the connection's secrets scope is limited to its own previews. Ask the user to reconnect (`/mcp`) and allow this repository, or to add them on the project's Secrets page in gangway.

## 3c. The user's own domain, if they ask for one

Previews are named `<slug>-pr-<n>.<the server's domain>`. To put them under the user's domain instead, use the `domains` tool with `target: {project: "<slug>"}`:

- `claim: "*.previews.example.com"` names every PR preview under it. `claim: "www.example.com"` is one hostname for the project's production preview (`production: "<preview>"`).
- The answer lists two DNS records the user must add at their DNS provider: the `_acme-challenge` CNAME proves they own it, the other sends traffic here. Nothing moves the domain's DNS elsewhere.
- Once added, `domains` with `check: true` shows it active; then `use: "previews.example.com"` so new PR previews are named under it. Existing previews move on their next push.
- "lacks the repos.domains permission": the connection lacks the `projects` scope; ask the user to reconnect (`/mcp`).

## 4. Open the pull request

1. `git fetch origin` and `git switch -c gangway-previews origin/<default branch>`. If uncommitted changes block the switch, ask the user rather than moving them.
2. `git add .github/workflows/gangway-preview.yml`, plus the Dockerfile and `.dockerignore` if you wrote them. Nothing else.
3. Commit ("Add gangway PR previews"), `git push -u origin gangway-previews`.
4. `gh pr create --base <default branch> --title "Add gangway PR previews" --body …`. Say what the workflow does, the port, and that merging turns previews on for every PR.

The PR runs its own new workflow: GitHub runs `pull_request` workflows from the PR's merge commit. So this PR is the test.

## 5. Watch the first preview

- `gh pr checks --watch`. The build takes as long as a Docker build of this repository; the deploy about a minute more.
- Success: the PR has a comment starting `<!-- gangway-preview -->` with **Preview ready:** and the URL (`gh pr view --comments`). Open it with `curl -sI <url>`: a 200, or the login or password page, means it is up.
- Failure: `gh run view --log-failed`.
  - **build** failed: the Dockerfile. Fix it on the branch and push; the PR redeploys.
  - **deploy** failed: the job prints gangway's answer. For an app that started and crashed, call MCP `logs` with the preview name (`<slug>-pr-<n>`) and `source: "runtime"`.
  - **`denied: … write_package`** or `installation not allowed to Write organization package`: the repository's Actions settings cap `GITHUB_TOKEN`. The user sets Settings › Actions › General › Workflow permissions to "Read and write", or grants the repo access to the existing `preview` package.
  - **403 or 409 from gangway:** the project is disabled, set to the `webhook` trigger, or points at another repository. Check it in gangway.

## 6. Hand over

- The PR's URL and the preview URL, and whether the preview answered.
- Merge the PR to turn previews on for every pull request. Leave merging to the user.
- Forks' pull requests are skipped: GitHub gives their runs no OIDC token.
- Build-time secrets go in the repository's GitHub secrets (the workflow shows where). Runtime secrets are the project's: the `secrets` tool, or its Secrets page in gangway. Name the ones you set; never their values.
- What you did not check, e.g. "the app starts, but has no database in the preview".
