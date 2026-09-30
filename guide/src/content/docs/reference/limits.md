---
title: Known limits
description: What gangway does not do yet.
---

- There is no cap on concurrent builds; builds share the host with everything else.
- gangway speaks HTTP/1.1. It sends its assets precompressed (brotli or gzip), but a reverse proxy
  in front gives browsers HTTP/2, which loads the dashboard's many small files faster.
- Static previews served by gangway answer a single byte range, not several at once.
- A preview's logs are removed with the preview.
- GitHub is the only forge for pull-request previews.
- Let's Encrypt certificates come over DNS-01 through Cloudflare only; with another DNS provider,
  let a reverse proxy hold the certificate.
