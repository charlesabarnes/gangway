---
title: Domains
description: Name previews under more domains, claim your own, and serve a production hostname.
---

Previews are named `<label>.<domain>`. By default the domain is `GANGWAY_BASE_DOMAIN`;
`GANGWAY_PREVIEW_DOMAIN` moves them to their own domain, and `GANGWAY_PREVIEW_DOMAINS` lists more.

## Claiming a domain

Anyone with the permission can claim a domain they own:

- in **Admin → Domains & traffic**, for every repository;
- on a repository's **Domains** tab, for its previews, or a hostname for its production preview;
- on a preview, for a hostname such as `www.example.com`.

A claim asks for two DNS records at the domain's provider:

| Record                     | Type  | Value                                         | Why                                                   |
| -------------------------- | ----- | --------------------------------------------- | ----------------------------------------------------- |
| `_acme-challenge.<name>`   | CNAME | the `<id>.acme.<your base domain>` name shown | proves it is yours; answers the certificate challenge |
| `*.<name>` or the hostname | CNAME | your base domain                              | sends the traffic to gangway                          |

gangway checks every minute. With `GANGWAY_TLS_MODE=acme` and a Cloudflare token for the base
domain's zone, it then gets a certificate for the name and serves it by SNI, one certificate per
domain. A repository or preview picks its domain from those it may use; a preview moves when it is
next deployed or rebuilt. Agents can do all of this with the `domains` tool.

## Behind a reverse proxy

With a proxy in front, the proxy holds the certificates. Caddy can get one per name on demand,
asking gangway which names it serves:

```caddyfile
{
  on_demand_tls {
    ask http://gangway:8080/_gangway/tls/ask
  }
}
https:// {
  tls {
    on_demand
  }
  reverse_proxy https://gangway:8443 {
    transport http {
      tls_insecure_skip_verify
    }
  }
}
```

The ask is on gangway's plain-HTTP listener (`GANGWAY_LISTEN_HTTP_PORT`, which must be set for
this), and gangway answers it only from loopback or `GANGWAY_TRUSTED_PROXIES`, and only for names
it serves today. Nginx Proxy Manager needs a proxy host and certificate per domain, added by hand.

## Rate limits

Preview traffic is rate limited per visitor and per preview (**Admin → Domains & traffic**). Past
the limit a preview answers 429.
