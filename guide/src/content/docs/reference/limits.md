---
title: Known limits
description: What gangway does not do yet.
---

- Builds wait in one line, `GANGWAY_PREVIEW_BUILDS` at a time. The line has no length limit, and
  gangway does not check the host's free CPU, memory or disk before a build starts.
- gangway speaks HTTP/1.1. It sends its assets precompressed (brotli or gzip), but a reverse proxy
  in front gives browsers HTTP/2, which loads the dashboard's many small files faster.
- Static previews served by gangway answer a single byte range, not several at once.
- A preview's logs are removed with the preview.
- GitHub is the only forge for pull-request previews.
- Let's Encrypt certificates come over DNS-01 through Cloudflare only; with another DNS provider,
  let a reverse proxy hold the certificate.
