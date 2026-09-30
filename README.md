<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/header-dark.svg">
    <img alt="gangway: full-stack artifacts on your domain: decks, dashboards and small tools, from your agent, a pull request, or a folder dropped in the browser." src=".github/assets/header-light.svg" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://gangway.sh/docs/">Docs</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="https://gangway.sh/docs/use/agents/">Connect an agent</a> ·
  <a href="https://gangway.sh/docs/use/pull-requests/">Pull-request previews</a> ·
  <a href="LICENSE">Apache-2.0</a>
</p>

---

**[gangway](https://gangway.sh)** gives any containerized app a public HTTPS URL on your own domain.

Hosted platforms will put your app on a URL, but on their servers, for the frameworks they
support, at their prices. I had a server with room to spare and kept needing a link for
something: a visual review for a frontend pull request, a build for a client, a deck an agent
had just made. gangway is the one place, on hardware you already own, that turns any of those
into a URL in seconds.

You get a URL in three ways, and all three produce the same kind of preview:

1. **A pull request** opens or updates. The preview is linked from a sticky comment and torn
   down when the PR closes.
2. **An agent** calls the MCP `deploy` tool. It works with Claude Code, Codex, Cursor, VS Code or
   any MCP client. The call blocks until the URL actually answers, then returns it.
3. **A person** deploys from the web UI or the REST API: drop in files, paste a Compose stack,
   or point at a git ref.

It runs as a single process on a plain Docker host, with no Kubernetes. You self-host it on
your own domain.

https://github.com/user-attachments/assets/f53178ca-89fc-4ecf-b6b7-bf7490b57ac2

## What you get

- **A URL per preview under one wildcard certificate**, such as
  `shop-pr-142.preview.example.com`. There is no per-preview certificate, so Let's Encrypt
  rate limits never bite.
- **Full Docker Compose stacks**, not just single containers. Several services, healthchecks
  and seed hooks all work, and each exposed service gets its own hostname.
- **No Dockerfile needed.** Static, Node, Bun, Deno, workerd, Python and PHP apps are detected
  from their files, and a `gangway.yml` can say more.
- **Throwaway databases.** Postgres, MySQL or Redis run beside the app, their URLs are handed
  to it as environment variables, and they are gone when the preview is. The preview page has
  a data browser.
- **Previews expire and sleep.** Each preview gets a time to live, idle ones go to sleep, and
  the first request wakes them.
- **Who can see a preview is up to you.** A preview can be public, unlisted (an unguessable
  hostname), password-protected, or visible only to people signed in to gangway.
- **Static sites and artifacts are served by gangway itself.** They need no container and
  deploy in milliseconds. One `artifact.md` renders as a document, a slide deck, a dashboard
  or a prototype.
- **Accounts and permissions.** Roles are made of per-feature permissions that you can remap.
  There are API tokens and OAuth for MCP clients, and an audit log.

## How it works

```
app.<domain>   ─┐
api.<domain>   ─┼─▶  UI · REST API · OAuth ─┐
mcp.<domain>   ─┤    MCP                    │
hooks.<domain> ─┘    GitHub webhooks        ├─▶ builder · scheduler · SQLite
                                            │          │
*.<domain>     ───▶  proxy: gate, wake ─────┘          ▼ Docker API
                          │                     Docker host(s)
                          └──────────────────▶  your preview's containers
```

gangway dispatches every request on its `Host` header. The reserved labels (`app`, `api`,
`mcp`, `hooks`) reach gangway itself, and every other label is a preview. It runs your stack
with `docker compose`, under a policy that refuses anything that would reach the host:
privileged mode, bind mounts, host networking, the Docker socket and the like. It also drops
Linux capabilities and applies memory and process limits. SQLite is the source of truth, and
every container carries labels that describe it, so a restart reconciles the two.

## Quickstart

> **Status: early.** gangway is v0.x and runs in production for its author. Expect rough edges,
> and read [Security](https://gangway.sh/docs/reference/security/) before you expose it.

On a host with Docker, as root or a user in the `docker` group:

```sh
curl -fsSL gangway.sh/install | sh
```

The installer asks where gangway answers: on your domain behind a reverse proxy (the default),
on your domain with gangway holding port 443 and its own Let's Encrypt certificate, or with no
domain (`--lan` to try it from your network, `--local` for this machine only). It starts gangway
and prints a one-time link that creates the first admin account; there are no default
credentials. Run it again to upgrade; a new version that does not come up healthy is rolled back.

- **[Install](https://gangway.sh/docs/install/linux/)**: flags, platforms, and running it by hand
  with `compose.yaml`.
- **[Unraid](https://gangway.sh/docs/install/unraid/)**: **gangway-inabox** runs gangway in a VM
  it creates, like Home Assistant in a Box; the plain **gangway** template runs it on Unraid's
  Docker. The templates are in [`unraid/`](unraid/).
- **[In a VM](https://gangway.sh/docs/install/vm/)**: [`vm/cloud-init.yaml`](vm/cloud-init.yaml)
  turns a stock Debian or Ubuntu cloud image into a gangway VM, in any hypervisor.
- **[Reverse proxy](https://gangway.sh/docs/setup/reverse-proxy/)**: Nginx Proxy Manager, SWAG,
  Caddy and Traefik.

### Deploy something

From the UI, go to **New preview** and drop in a folder. You can also start from a runtime's
example, or add a throwaway database.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screenshots/new-dark.png">
  <img alt="The New preview page: runtime starters, a drop zone for a folder, files or a .zip, and Postgres, MySQL and Redis add-ons." src=".github/assets/screenshots/new-light.png" width="100%">
</picture>

From a terminal:

```sh
tar -czf - . | curl --fail -X POST \
  -H "Authorization: Bearer $GANGWAY_TOKEN" -H "Content-Type: application/gzip" \
  --data-binary @- "https://api.preview.example.com/v1/previews?name=hello&runtime=auto&wait=true"
```

The answer includes the URL once the preview serves it. Create tokens under **Account**.
[Deploying](https://gangway.sh/docs/use/deploy/) covers how gangway reads an app, `gangway.yml`,
databases, expiry and visibility.

## Connect an agent

Turn on MCP under **Admin → Server → Surfaces**, then copy your client's setup from **Account →
Connect an agent**. For Claude Code:

```sh
claude plugin marketplace add charlesabarnes/gangway && \
  claude plugin install gangway@gangway --config mcp_url=https://mcp.preview.example.com/
```

Run `/mcp`, sign in to gangway, and choose what the agent may do. Any MCP client works with the
MCP URL; [Connect an agent](https://gangway.sh/docs/use/agents/) has the scopes, the tools, and
settings that make Claude Code pick gangway over its own artifacts.

## Pull-request previews

1. Under **Admin → GitHub**, create a GitHub App in one click through GitHub's manifest
   flow, so no secret is copied by hand. Install it on your repositories.
2. Under **Repositories**, connect a repository. By default gangway gives you a workflow file to
   commit. It builds on GitHub Actions and hands gangway the image, authenticated by the run's
   OIDC token. The alternative is to have gangway build from webhooks.
3. Open a PR. The preview's URL arrives in a sticky comment and a GitHub Deployment. Pull
   requests from forks wait until a maintainer comments `/preview deploy`.

## Documentation

Everything else is at **[gangway.sh/docs](https://gangway.sh/docs/)**:
[configuration](https://gangway.sh/docs/setup/configuration/),
[domains](https://gangway.sh/docs/use/domains/), [sharing](https://gangway.sh/docs/use/sharing/),
[upgrades and backups](https://gangway.sh/docs/setup/upgrades/),
[security](https://gangway.sh/docs/reference/security/),
[known limits](https://gangway.sh/docs/reference/limits/) and
[troubleshooting](https://gangway.sh/docs/reference/troubleshooting/). The docs' source is in
[`guide/`](guide/).

gangway talks to the Docker socket, which is **root on its host**; read
[Security](https://gangway.sh/docs/reference/security/) before you give anyone an account. Report
vulnerabilities privately through GitHub's **Security → Report a vulnerability**, or by email to
security@gangway.sh, not in an issue.

## Development

```sh
bun install
bun run test         # server, shared and render; no Docker needed
bun run typecheck && bun run lint
cp scripts/dev.example.json scripts/dev.json   # then point it at your Docker host
GANGWAY_CONFIG=scripts/dev.json bun run dev
cd web && npm install && npm start   # the Angular UI
```

The server is TypeScript on [Bun](https://bun.sh), [Hono](https://hono.dev) and
`bun:sqlite`. The UI is Angular with Tailwind. Every dependency is free of native addons.

## License

[Apache-2.0](LICENSE)
