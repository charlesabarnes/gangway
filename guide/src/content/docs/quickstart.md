---
title: Quickstart
description: Install gangway on a Docker host, create the first admin, and deploy something.
---

## What you need

- A host with Docker (Engine, Desktop or Colima) or Podman, with Compose.
- To serve previews on your own domain:
  - a domain with a **wildcard DNS record**, such as `preview.example.com` and
    `*.preview.example.com`, pointing at the host (or at the reverse proxy in front of it);
  - a **wildcard certificate** for it. A reverse proxy in front can hold it, or gangway can get
    one itself from Let's Encrypt with a Cloudflare API token.

No domain yet? Install with `--lan` to try gangway from any machine on your network, or `--local`
for this machine only. See [Choosing a mode](/docs/install/modes/).

## Install

On the host, as root or a user in the `docker` group:

```sh
curl -fsSL gangway.sh/install | sh
```

The installer asks where gangway should answer:

| Answer              | What it means                                                          |
| ------------------- | ---------------------------------------------------------------------- |
| `proxy` _(default)_ | your domain, behind a reverse proxy already on this host               |
| `acme`              | your domain, with gangway holding port 443 and getting its certificate |
| `lan`               | no domain, on your network, to try it out                              |
| `local`             | no domain, on this machine only                                        |

It then checks Docker, DNS and the ports, writes `/opt/gangway/.env` and `compose.yaml`, starts
gangway, and prints a one-time link. On Unraid, see [Unraid](/docs/install/unraid/) instead.

## Create the first admin

Open the link the installer printed. There are no default credentials: the link creates the first
admin account. Until that account exists, the link changes on every start, and this prints the
current one:

```sh
docker logs gangway 2>&1 | grep setup
```

## Deploy something

In the dashboard, go to **New preview** and drop in a folder, or start from a runtime's example.
A few seconds later the preview has its own URL.

From a terminal, with a token from **Account**:

```sh
tar -czf - . | curl --fail -X POST \
  -H "Authorization: Bearer $GANGWAY_TOKEN" -H "Content-Type: application/gzip" \
  --data-binary @- "https://api.preview.example.com/v1/previews?name=hello&runtime=auto&wait=true"
```

## Next

- [Connect an agent](/docs/use/agents/), so Claude Code, Codex or Cursor can deploy for you.
- [Pull-request previews](/docs/use/pull-requests/) for your GitHub repositories.
- [Put a reverse proxy in front](/docs/setup/reverse-proxy/), if you chose `proxy`.
