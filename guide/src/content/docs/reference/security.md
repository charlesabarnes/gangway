---
title: Security
description: What gangway's access to Docker means, how previews are contained, and how to report a vulnerability.
---

## gangway is root on its host

gangway talks to the Docker socket, which is **root on that host**. Give dashboard accounts and
tokens only to people you would trust with a shell there, or keep the dashboard and API on your
own network with `GANGWAY_CONTROL_ALLOW` (below). To keep that power off a machine that does other
work, run gangway [in a VM](/docs/install/vm/); on Unraid,
[gangway-inabox](/docs/install/unraid/) does it for you.

## Previews are treated as hostile

- A compose file may use only the fields listed [below](#what-a-compose-file-may-use). Anything
  else is refused by name, so host namespaces, bind mounts, devices and added capabilities never
  reach Docker, and neither does a field a newer Compose adds.
- Every container runs with `no-new-privileges`, without `NET_RAW`, and under memory and process
  limits.
- Previews publish their ports on the host's `127.0.0.1` only, so gangway's visibility gate is the
  only way in.
- Secrets never reach a build: a compose file that puts one in `build.args`, a label or an
  inline Dockerfile is refused.
- Single-service previews share one network only where the engine stops its containers talking
  to each other. Anywhere else, each preview gets a network of its own.
- At most `GANGWAY_PREVIEW_BUILDS` images build at once (2 by default). Builds run outside the
  container limits.

**Previews can reach the internet and your LAN.** If that matters, firewall the preview networks
(Docker's `DOCKER-USER` chain), or give gangway a Docker host of its own.

## What a compose file may use

gangway checks the file after `docker compose config` has resolved it. A service may use:

`attach`, `build`, `cap_drop`, `command`, `configs`, `cpu_count`, `cpu_percent`, `cpu_period`,
`cpu_quota`, `cpu_shares`, `cpus`, `cpuset`, `depends_on`, `deploy`, `develop`, `domainname`,
`entrypoint`, `env_file`, `environment`, `expose`, `extends`, `group_add`, `healthcheck`,
`hostname`, `image`, `init`, `label_file`, `labels`, `links`, `mem_limit`, `mem_reservation`,
`mem_swappiness`, `memswap_limit`, `network_mode`, `networks`, `oom_score_adj`, `pids_limit`,
`platform`, `ports`, `post_start`, `pre_stop`, `profiles`, `pull_policy`, `read_only`, `restart`,
`scale`, `secrets`, `shm_size`, `stdin_open`, `stop_grace_period`, `stop_signal`, `tmpfs`, `tty`,
`ulimits`, `user`, `volumes`, `volumes_from`, `working_dir`, and any `x-` extension.

Some of these are checked further. `build` is limited to a context inside the upload, and
`deploy` to resources, replicas, labels and a restart policy. Volumes must be named volumes or
tmpfs. `network_mode`, `volumes_from` and `links` may point only at the preview's own services.
Networks use the bridge driver, volumes the local driver, and secrets and configs inline `content`
only.

If your file needs a field that is not here, open an issue.

## Keep the dashboard private

`GANGWAY_CONTROL_ALLOW` limits the dashboard and API, the root-on-this-host part, to the networks
you list, while previews, MCP and webhooks stay public. Everyone else gets the same "nothing here"
page as an unknown preview:

```sh
GANGWAY_CONTROL_ALLOW=192.168.1.0/24,100.64.0.0/10
```

It judges the client address, so behind a proxy `GANGWAY_TRUSTED_PROXIES` must be right, and the
list must not include the proxy itself. Signing in to connect an agent, and "signed in" previews,
then work only from those networks.

One API call is let through from anywhere: a pull-request workflow deploying or tearing down its
own preview, which proves itself with the OIDC token GitHub signs for that run and may do nothing
else. gangway's own tokens still need a listed network.

## Previews on their own domain

Previews share a site with the dashboard unless you set `GANGWAY_PREVIEW_DOMAIN`. The session
cookie is host-only and cross-site requests are checked by `Origin`, but a separate preview domain
is the stronger setup for untrusted pull requests.

## Agents

An agent gets only the scopes you approve on the consent page. `artifacts` lets it deploy only
static sites and artifacts, and touch only what it deployed itself. Secrets are write-only for
agents: they see names, never values. See [Connect an agent](/docs/use/agents/).

## Reporting a vulnerability

Report it privately through GitHub's **Security → Report a vulnerability** on
[the repository](https://github.com/charlesabarnes/gangway/security), or by email to
security@gangway.sh, not in an issue. Only the latest release gets security fixes.
