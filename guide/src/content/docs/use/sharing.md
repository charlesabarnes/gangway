---
title: Sharing
description: Give a preview a public link through a Cloudflare quick tunnel, when people cannot reach your gangway.
---

On a local-only or `lan` install, nobody outside can open a preview. **Share** on a preview's page,
or asking your agent to share it, opens a
[Cloudflare quick tunnel](https://developers.cloudflare.com/tunnel/get-started/#quick-tunnels-development)
and hands back a public `https://….trycloudflare.com` link, until you stop it or it expires.

Quick tunnels need no Cloudflare account and are meant for testing:

- at most 200 requests at once;
- no server-sent events;
- a new link each time;
- a link lasts at most 24 hours by default (**Admin → Server**).

Sharing is on by default for local-only and `lan` installs. On a domain install your previews
already have public URLs, so it is off; an admin can turn it on in **Admin**, or pin it either way
with `GANGWAY_SHARE=true` or `false`. While it is off, `cloudflared` never starts.
