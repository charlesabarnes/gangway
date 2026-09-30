---
title: Troubleshooting
description: Common snags and how to get past them.
---

## Where is the first-admin link?

It is printed on every start until the first account exists, and only the latest one works:

```sh
docker logs gangway 2>&1 | grep setup
```

On Unraid it is in the container's log (**Docker → gangway → Logs**); with gangway-inabox, on its
WebUI. With a VM, in `/var/log/gangway-install.log` inside it.

## sslip.io names do not resolve

Your router, or a DNS filter such as Pi-hole or AdGuard Home, drops public DNS answers that point at
private addresses. That is DNS rebinding protection. Allow `sslip.io` in it:

- **dnsmasq** (OpenWrt, many routers): `rebind-domain-ok=/sslip.io/`
- **pfSense / OPNsense** (Unbound): add `private-domain: "sslip.io"` under custom options
- **AdGuard Home / Pi-hole**: allowlist `sslip.io`

Or install with a domain instead.

## Port already in use

The installer checks the ports it needs before it starts:

- **8443**, behind a proxy or local-only: pick another with `--port`.
- **80 and 443**, with `acme`: something else, often a NAS's own web UI, holds them. Use a reverse
  proxy (`--tls proxy`) instead.

A container that exits with `Failed to start server. Is port 8080 in use?` has a plain-HTTP
listener on 8080 it does not need: set `GANGWAY_LISTEN_HTTP_PORT` to empty.

## The proxy answers 502

The proxy cannot reach gangway, or tries to verify its certificate:

- The upstream is `https://`, not `http://`, and certificate verification is off.
- A proxy container in bridge mode reaches gangway at `172.17.0.1:8443`. A proxy on the host's
  LAN IP (Unraid's br0, macvlan) cannot reach `172.17.0.1`: have gangway listen on `::` and trust
  the proxy's IP (see [Reverse proxy](/docs/setup/reverse-proxy/)).
- `docker logs gangway` shows whether gangway itself is up.

## Deploys time out behind the proxy

nginx and Traefik cut requests off after 60 seconds by default, which ends `?wait=true` deploys and
builds. Raise the timeouts: [Reverse proxy](/docs/setup/reverse-proxy/).

## Browsers warn about the certificate

In `lan` and `local` modes, and behind a proxy that forwards to gangway directly, the certificate is
gangway's own. Accept it once per name, or trust its CA, `dev-ca/ca.pem` in the state folder.

## A preview will not start

Its page shows the build and runtime logs, as does the `logs` tool for an agent. If gangway could
not work out how to run the app, the deploy says which file would settle it; see
[Deploying](/docs/use/deploy/#how-gangway-reads-an-app).

## Still stuck

Open an issue on [GitHub](https://github.com/charlesabarnes/gangway/issues) with what you ran and
`docker logs gangway`.
