#!/usr/bin/env bash
# Development against a remote Docker host: gangway runs locally, containers run on the host.
# One SSH connection carries both things gangway needs from it:
#
#   -L 23750 -> /var/run/docker.sock   the Docker API     (DOCKER_HOST=tcp://127.0.0.1:23750)
#   -D 1080                            a SOCKS5 proxy, so the reverse proxy can reach ports
#                                      that previews publish on the host's 127.0.0.1
#
# Publishing to the host's loopback keeps previews off its LAN; only this tunnel reaches them.
# The tunnel drops whenever this machine sleeps, which gangway treats as an unreachable host.
#
#   GANGWAY_TUNNEL_HOST=my-docker-host bun run tunnel
#
# Pair it with a copy of scripts/dev.example.json.
set -euo pipefail
HOST="${GANGWAY_TUNNEL_HOST:?set GANGWAY_TUNNEL_HOST to the SSH host that runs Docker}"
DOCKER_PORT="${GANGWAY_TUNNEL_DOCKER_PORT:-23750}"
SOCKS_PORT="${GANGWAY_TUNNEL_SOCKS_PORT:-1080}"

echo "tunnel to ${HOST}: docker on 127.0.0.1:${DOCKER_PORT}, socks5 on 127.0.0.1:${SOCKS_PORT} (Ctrl-C to close)"
exec ssh -N \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L "127.0.0.1:${DOCKER_PORT}:/var/run/docker.sock" \
  -D "127.0.0.1:${SOCKS_PORT}" \
  "${HOST}"
