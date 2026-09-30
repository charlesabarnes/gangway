---
title: On a laptop
description: Run gangway local-only on Docker Desktop, Colima or Podman, and share previews through a tunnel.
---

On Docker Desktop, Colima or Podman, the installer sets gangway up **local-only**:

```sh
curl -fsSL gangway.sh/install | sh
```

The dashboard, API, MCP and previews live under `*.preview.localhost`, at
`https://app.preview.localhost:8443`. Browsers and `curl` send every `*.localhost` name to the
machine they run on, so there is no DNS or domain to set up. Browsers warn once about gangway's own
certificate; its CA is `~/.gangway/state/dev-ca/ca.pem` if you want to trust it.

Nobody else can open a `*.localhost` URL. To show a preview to someone, press **Share** on its page,
or ask your agent to share it. See [Sharing](/docs/use/sharing/).

:::caution[Docker Desktop]
gangway uses host networking. If the installer says gangway is up inside Docker but not reachable,
turn on **Settings → Resources → Network → Enable host networking**, then run it again.
:::

To install local-only on a server instead, pass `--local`. From another computer you then reach it
through an SSH tunnel: `ssh -L 8443:localhost:8443 <server>`. To reach it from your whole network
without a tunnel, use [`--lan`](/docs/install/modes/#lan).
