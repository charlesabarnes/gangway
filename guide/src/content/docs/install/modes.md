---
title: Choosing a mode
description: proxy, acme, lan or local, and how to pick between them.
---

Every install has a mode that decides who holds port 443 and the certificate, and where gangway
answers. The installer asks; `--tls`, `--lan` and `--local` answer for it.

| Mode                | Domain | Certificate                   | Reachable from       |
| ------------------- | ------ | ----------------------------- | -------------------- |
| `proxy` _(default)_ | yours  | your reverse proxy's wildcard | wherever you publish |
| `acme`              | yours  | gangway's, from Let's Encrypt | wherever you publish |
| `lan`               | none   | gangway's own (browser warns) | your network         |
| `local`             | none   | gangway's own (browser warns) | this machine         |

## proxy

A reverse proxy you already run (Nginx Proxy Manager, SWAG, Caddy, Traefik) holds 443 and the
wildcard certificate, and forwards `preview.example.com` and `*.preview.example.com` to gangway
over HTTPS. gangway listens on `172.17.0.1:8443` by default, where a proxy container in Docker's
bridge network reaches it. This is the default because most servers and every NAS already have
something on 443. See [Reverse proxy](/docs/setup/reverse-proxy/).

## acme

gangway holds ports 80 and 443 itself and gets a Let's Encrypt wildcard certificate over DNS-01.
DNS-01 works through Cloudflare, so the domain's DNS must be on Cloudflare and gangway needs an API
token with **Zone → DNS → Edit** on it. Nothing needs to reach gangway from the internet for the
certificate, so this works on a LAN-only server too.

## lan

No domain: gangway answers at `https://app.<host-ip>.sslip.io:8443` on your network, for trying it
out.

[sslip.io](https://sslip.io) is a free public DNS service that answers any name with the IP in it:
`app.192-168-1-14.sslip.io` resolves to `192.168.1.14`, and so does every name under
`192-168-1-14.sslip.io`. That gives gangway a wildcard domain that every machine on your network
can resolve, with nothing to buy or set up. The trade-offs:

- It depends on a third-party service.
- Some routers drop public DNS answers that point at private addresses (DNS rebinding
  protection). If the names do not resolve, see
  [Troubleshooting](/docs/reference/troubleshooting/#sslipio-names-do-not-resolve).
- The certificate is gangway's own, so browsers warn once per name.

Share links are on, so **Share** makes any preview public.

## local

No domain, this machine only, under `*.preview.localhost`. The default on a laptop; see
[On a laptop](/docs/install/laptop/).

## Changing mode later

The mode is a handful of settings in `/opt/gangway/.env` (or the Unraid template):
`GANGWAY_BASE_DOMAIN`, `GANGWAY_TLS_MODE`, `GANGWAY_LISTEN_ADDRESS`, `GANGWAY_LISTEN_PORT`,
`GANGWAY_PUBLIC_PORT` and `GANGWAY_TRUSTED_PROXIES`. [Configuration](/docs/setup/configuration/)
lists them all.
