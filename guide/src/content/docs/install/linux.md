---
title: Linux and NAS
description: Install gangway with the one-line installer on Linux, a NAS, or by hand with Compose.
---

```sh
curl -fsSL gangway.sh/install | sh
```

Run it on the host, as root or a user in the `docker` group. It asks for anything a flag did not
give, starts gangway, and prints the link that creates the first admin.

## Where it installs

The installer works out what it runs on and installs the way that platform expects.

| Platform            | Installed as                                           | Status       |
| ------------------- | ------------------------------------------------------ | ------------ |
| Linux               | a Compose project in `/opt/gangway`                    | verified     |
| Unraid              | a Docker-tab template with the icon                    | experimental |
| TrueNAS SCALE       | a custom app                                           | experimental |
| CasaOS              | a Compose project that shows up as an app              | experimental |
| Synology            | a Compose project in `/volume1/docker/gangway`         | experimental |
| Docker Desktop etc. | local-only, on `*.preview.localhost` (see [Laptop][l]) | experimental |

Experimental means written to the platform's conventions but not yet verified on it. Reports
are welcome in [GitHub issues](https://github.com/charlesabarnes/gangway/issues). On Unraid,
the [Unraid templates](/docs/install/unraid/) are the tested path.

[l]: /docs/install/laptop/

## Flags

Every question has a flag, so it can run unattended:

```sh
curl -fsSL gangway.sh/install | sh -s -- --domain preview.example.com --tls acme --cf-token … --yes
```

| Flag                        | Meaning                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `--domain <domain>`         | base domain, e.g. `preview.example.com`                                 |
| `--tls proxy\|acme\|local`  | who holds port 443 and the certificate ([modes](/docs/install/modes/))  |
| `--lan`                     | no domain, reachable on your network at `*.<host-ip>.sslip.io`          |
| `--local`                   | no domain, this machine only                                            |
| `--cf-token <token>`        | Cloudflare API token with DNS edit on the domain (`acme`)               |
| `--acme-dns-url <url>`      | an [acme-dns](/docs/install/modes/#acme) server, instead of Cloudflare  |
| `--acme-dns-user <user>`    | its account's username (or `GANGWAY_ACME_DNS_USERNAME`)                 |
| `--acme-dns-key <key>`      | its account's password (or `GANGWAY_ACME_DNS_PASSWORD`)                 |
| `--acme-dns-subdomain <s>`  | its account's subdomain (or `GANGWAY_ACME_DNS_SUBDOMAIN`)               |
| `--acme-email <email>`      | contact address for Let's Encrypt (`acme`, optional)                    |
| `--listen <address>`        | where gangway listens behind a proxy (default the docker0 gateway)      |
| `--trusted-proxies <cidrs>` | where the proxy connects from (default the docker0 subnet)              |
| `--port <port>`             | port gangway listens on behind a proxy (default 8443)                   |
| `--version <v>`             | image tag, e.g. `0.3.3` or `edge` (default `latest`)                    |
| `--name <name>`             | container name, for a second gangway on one host (pair it with `--dir`) |
| `--dir <path>`              | where gangway's files live                                              |
| `--platform <p>`            | skip detection: `linux`, `unraid`, `truenas`, `casaos`, `synology`, …   |
| `--rollback`                | put back the version and database from before the last upgrade          |
| `--upgrade`                 | only upgrade: fail if gangway is not installed there, for scripts       |
| `-y`, `--yes`               | do not ask; fail if something required is missing                       |

With `--yes` and no domain, it stops and asks for `--domain` or `--lan`: a reverse proxy is the
default.

## By hand

[`compose.yaml`](https://github.com/charlesabarnes/gangway/blob/master/compose.yaml) documents
every setting inline. Next to it, write a `.env`:

```sh
GANGWAY_ADMIN_TOKEN=gw_REPLACE_ME          # echo "gw_$(openssl rand -hex 24)"
GANGWAY_BASE_DOMAIN=preview.example.com
GANGWAY_STATE_PATH=/srv/gangway            # SQLite, logs and uploads
```

then `docker compose up -d`. That assumes a reverse proxy holds port 443 and the certificate. To
have gangway hold 443 and get its own certificate instead, add:

```sh
GANGWAY_LISTEN_ADDRESS=::
GANGWAY_LISTEN_PORT=443
GANGWAY_LISTEN_HTTP_PORT=80
GANGWAY_TLS_MODE=acme
GANGWAY_TRUSTED_PROXIES=
GANGWAY_CF_API_TOKEN=...                   # a Cloudflare token that can edit the zone's DNS
# or, for DNS that is not on Cloudflare, an acme-dns account:
# GANGWAY_ACME_DNS_URL=https://auth.example.org  GANGWAY_ACME_DNS_USERNAME=...
# GANGWAY_ACME_DNS_PASSWORD=...  GANGWAY_ACME_DNS_SUBDOMAIN=...
GANGWAY_ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory
```

To build from a checkout instead of pulling the published image:
`docker compose -f compose.yaml -f compose.build.yaml up -d --build`.
