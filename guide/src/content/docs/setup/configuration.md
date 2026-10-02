---
title: Configuration
description: Every environment variable gangway reads.
---

Everything can be set in the environment: `/opt/gangway/.env` for an installer install, the
template on Unraid. Settings not pinned there are editable in **Admin**.
[`compose.yaml`](https://github.com/charlesabarnes/gangway/blob/master/compose.yaml) documents
them inline too. Your own changes to the compose setup go in `compose.override.yaml` beside it,
which upgrades leave alone.

## Domains

| Variable                  | Default          |                                                                    |
| ------------------------- | ---------------- | ------------------------------------------------------------------ |
| `GANGWAY_BASE_DOMAIN`     | required         | Domain for the UI, API, MCP and, by default, previews              |
| `GANGWAY_PREVIEW_DOMAIN`  | _(base domain)_  | Put previews on their own registrable domain                       |
| `GANGWAY_PREVIEW_DOMAINS` | _(none)_         | More wildcard domains previews may be named under, comma-separated |
| `GANGWAY_INSTANCE`        | `main` (compose) | Prefix for this install's containers: `gw-<instance>-<slug>`       |

## Listening and TLS

| Variable                     | Default                   |                                                                  |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------- |
| `GANGWAY_LISTEN_ADDRESS`     | `172.17.0.1` (compose)    | Address gangway listens on; `::` for every address               |
| `GANGWAY_LISTEN_PORT`        | `8443`                    | HTTPS port                                                       |
| `GANGWAY_LISTEN_HTTP_PORT`   | empty (compose)           | Plain-HTTP port that redirects to HTTPS; empty for none          |
| `GANGWAY_PUBLIC_PORT`        | `443` (compose)           | The port in the URLs gangway hands out                           |
| `GANGWAY_TRUSTED_PROXIES`    | `172.17.0.0/16` (compose) | Proxies whose `X-Forwarded-For` is believed                      |
| `GANGWAY_TLS_MODE`           | `selfsigned`              | `selfsigned`, `acme` (Let's Encrypt over DNS-01) or `file`       |
| `GANGWAY_TLS_CERT_PATH`      | _(none)_                  | Certificate for `file` mode                                      |
| `GANGWAY_TLS_KEY_PATH`       | _(none)_                  | Key for `file` mode                                              |
| `GANGWAY_CF_API_TOKEN`       | _(none)_                  | Cloudflare token with DNS edit, for `acme`                       |
| `GANGWAY_CF_ZONE_ID`         | _(looked up)_             | The zone, if the token cannot list zones                         |
| `GANGWAY_ACME_EMAIL`         | _(none)_                  | Contact address for Let's Encrypt                                |
| `GANGWAY_ACME_DIRECTORY_URL` | staging (compose)         | Set to `https://acme-v02.api.letsencrypt.org/directory` for real |

## Access

| Variable                | Default      |                                                                |
| ----------------------- | ------------ | -------------------------------------------------------------- |
| `GANGWAY_ADMIN_TOKEN`   | _(none)_     | Break-glass admin token, the only one that can mint tokens     |
| `GANGWAY_CONTROL_ALLOW` | _(everyone)_ | Networks allowed to reach the UI and API; previews stay public |
| `GANGWAY_SURFACE_UI`    | _(Admin)_    | Pin the dashboard on or off                                    |
| `GANGWAY_SURFACE_MCP`   | `false`      | Pin the MCP surface on or off                                  |
| `GANGWAY_SHARE`         | on if local  | Pin share links on or off; while off, cloudflared never starts |

## Previews

| Variable                       | Default              |                                                                             |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------- |
| `GANGWAY_PREVIEW_MEMORY`       | `1g`                 | Memory limit for every preview container; 0 is off                          |
| `GANGWAY_PREVIEW_CPUS`         | off                  | CPU limit for every preview container                                       |
| `GANGWAY_PREVIEW_PIDS`         | `1024`               | Process limit for every preview container                                   |
| `GANGWAY_PREVIEW_BUILDS`       | `2`                  | Image builds at once; the rest wait their turn; 0 is off                    |
| `GANGWAY_PREVIEW_BUILD_QUEUE`  | `10`                 | Builds that may wait; past it a deploy is turned away; 0 is off             |
| `GANGWAY_PREVIEW_BUILD_MEMORY` | `512m`               | Memory the host must have available for a build to start; 0 is off          |
| `GANGWAY_PREVIEW_BUILD_DISK`   | `2g`                 | Free space gangway's state disk must have for a build to start; 0 is off    |
| `GANGWAY_RECONCILE_ORPHANS`    | `report` (installer) | `report` or `stop` containers that look like gangway's but it does not know |

## Email, updates, GitHub

| Variable                     | Default   |                                                                        |
| ---------------------------- | --------- | ---------------------------------------------------------------------- |
| `GANGWAY_SMTP_URL`           | _(Admin)_ | `smtp://user:pass@host:587` or `smtps://…:465`, for invites and resets |
| `GANGWAY_MAIL_FROM`          | _(Admin)_ | The sender address                                                     |
| `GANGWAY_UPDATE_CHECK`       | on        | `false` stops the daily check for a new release                        |
| `GANGWAY_GITHUB_APP_ID` etc. | _(Admin)_ | The GitHub App, if not created from **Admin → GitHub**                 |

## Paths and logging

| Variable              | Default       |                                               |
| --------------------- | ------------- | --------------------------------------------- |
| `GANGWAY_STATE_DIR`   | `/state`      | Database, logs, uploads and backups           |
| `GANGWAY_LOG_LEVEL`   | `info`        | `debug`, `info`, `warn` or `error`            |
| `GANGWAY_CLOUDFLARED` | `cloudflared` | The binary share links run; the image has one |
