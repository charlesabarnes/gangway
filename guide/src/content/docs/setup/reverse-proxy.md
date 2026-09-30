---
title: Reverse proxy
description: Put gangway behind Nginx Proxy Manager, SWAG, Caddy or Traefik.
---

In `proxy` mode, the default, a reverse proxy you already run holds port 443 and the wildcard
certificate. Whatever the proxy, it needs to:

- answer for **`preview.example.com` and `*.preview.example.com`**, with one wildcard
  certificate for both (a wildcard needs a DNS challenge);
- forward to **`https://172.17.0.1:8443`**, gangway's listener on Docker's bridge, **without
  verifying** its self-signed certificate;
- keep the **`Host` header**, pass websockets, and not cut long requests: a deploy with
  `wait=true` or a build can take minutes, and uploads can be large.

```
internet :443 → reverse proxy (wildcard certificate)
                  → https://172.17.0.1:8443  gangway (self-signed)
                      → 127.0.0.1:31xxx       the previews
```

gangway believes `X-Forwarded-For` only from `GANGWAY_TRUSTED_PROXIES`, `172.17.0.0/16` by default,
which covers a proxy container on the bridge. A proxy on another machine or with its own LAN IP
needs gangway to listen on its LAN address and trust that IP: install with
`--listen :: --trusted-proxies <proxy-ip>/32`, or set `GANGWAY_LISTEN_ADDRESS=::` and
`GANGWAY_TRUSTED_PROXIES`. The upstream is then `https://<gangway-host-ip>:8443`.

## Nginx Proxy Manager

Add a **Proxy Host**:

- **Details:** domain names `preview.example.com` and `*.preview.example.com`; scheme `https`;
  forward hostname `172.17.0.1`, port `8443`; turn on **Websockets Support**.
- **SSL:** request a new certificate for both names with **Use a DNS Challenge**; turn on **Force
  SSL** and **HTTP/2**.
- **Advanced:**

  ```nginx
  proxy_read_timeout 600s;
  proxy_send_timeout 600s;
  client_max_body_size 512m;
  proxy_request_buffering off;
  ```

nginx's default 60-second timeout cuts off `?wait=true` deploys and builds; the last two lines are
for tarball uploads. Server-sent events need nothing: gangway sends `X-Accel-Buffering: no`.

## SWAG

SWAG's certificate has to cover `*.preview.example.com`: with DNS validation, add it to
`EXTRA_DOMAINS` (a wildcard for `example.com` does not cover a name two levels down). Then add
`/config/nginx/proxy-confs/gangway.subdomain.conf`:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name preview.example.com *.preview.example.com;
    include /config/nginx/ssl.conf;
    client_max_body_size 512m;

    location / {
        include /config/nginx/proxy.conf;
        include /config/nginx/resolver.conf;
        proxy_pass https://172.17.0.1:8443;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_request_buffering off;
    }
}
```

## Caddy

With a DNS plugin for your provider (Cloudflare here) for the wildcard certificate:

```caddyfile
preview.example.com, *.preview.example.com {
  tls {
    dns cloudflare {env.CF_API_TOKEN}
  }
  reverse_proxy https://172.17.0.1:8443 {
    transport http {
      tls_insecure_skip_verify
    }
  }
}
```

Caddy can also get a certificate per name on demand, for domains claimed in gangway; see
[Domains](/docs/use/domains/#behind-a-reverse-proxy).

## Traefik

In a file-provider dynamic configuration:

```yaml
http:
  routers:
    gangway:
      rule: "Host(`preview.example.com`) || HostRegexp(`^[a-z0-9-]+\\.preview\\.example\\.com$`)"
      entryPoints: [websecure]
      service: gangway
      tls:
        certResolver: cloudflare
        domains:
          - main: preview.example.com
            sans: ["*.preview.example.com"]
  services:
    gangway:
      loadBalancer:
        serversTransport: gangway
        servers:
          - url: https://172.17.0.1:8443
  serversTransports:
    gangway:
      insecureSkipVerify: true
```

Traefik v3 cuts requests off after 60 seconds by default. Raise it on the entry point, in the
static configuration: `entryPoints.websecure.transport.respondingTimeouts.readTimeout: 600s`.

## Check it

`https://app.preview.example.com` should show gangway's sign-in page, and
`https://api.preview.example.com/healthz` should answer `{"ok":true,…}`.
