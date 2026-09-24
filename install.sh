#!/bin/sh
# Installs or upgrades gangway on this Docker host.
#
#   curl -fsSL https://github.com/charlesabarnes/gangway/releases/latest/download/install.sh | sh
#
# It asks for anything it needs that a flag did not give, writes <dir>/.env and
# <dir>/compose.yaml, starts gangway and prints the one-time link that creates the first
# admin. Running it again upgrades: the .env is kept, compose.yaml and the image are
# refreshed. Pass everything as flags (and --yes) to run it without a terminal.
set -eu

REPO=charlesabarnes/gangway
DIR=/opt/gangway
DOMAIN=
TLS=
CF_TOKEN=
ACME_EMAIL=
VERSION=latest
IMAGE=
COMPOSE_FILE_SRC=
ASSUME_YES=0
SKIP_PULL=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --domain <domain>       base domain, e.g. preview.example.com (*.<domain> must point here)
  --tls proxy|acme        proxy: a reverse proxy in front holds 443 and the certificate
                          acme:  gangway holds 443 and gets a wildcard certificate itself
                                 (Let's Encrypt over DNS-01, needs a Cloudflare API token)
  --cf-token <token>      Cloudflare API token that can edit the domain's DNS (acme only)
  --acme-email <email>    contact address for Let's Encrypt (acme only, optional)
  --dir <path>            where .env, compose.yaml and state live (default /opt/gangway)
  --version <v>           image tag to run, e.g. 0.1.0 (default latest)
  --image <name>          image to run instead of ghcr.io/charlesabarnes/gangway
  --compose-file <path>   use this compose.yaml instead of downloading the release's
  --no-pull               run an image already on this host (with --image)
  -y, --yes               do not ask; fail if something required is missing
  -h, --help              show this help
EOF
}

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a value}; shift ;;
    --tls) TLS=${2:?--tls needs a value}; shift ;;
    --cf-token) CF_TOKEN=${2:?--cf-token needs a value}; shift ;;
    --acme-email) ACME_EMAIL=${2:?--acme-email needs a value}; shift ;;
    --dir) DIR=${2:?--dir needs a value}; shift ;;
    --version) VERSION=${2:?--version needs a value}; shift ;;
    --image) IMAGE=${2:?--image needs a value}; shift ;;
    --compose-file) COMPOSE_FILE_SRC=${2:?--compose-file needs a value}; shift ;;
    --no-pull) SKIP_PULL=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# Piped from curl, stdin is the script itself, so questions are read from the terminal.
ask() { # ask <prompt> <default> -> answer on stdout
  [ "$ASSUME_YES" = 1 ] && { printf '%s' "$2"; return; }
  [ -r /dev/tty ] || die "no terminal to ask \"$1\"; pass it as a flag (see --help)"
  if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2" >/dev/tty; else printf '%s: ' "$1" >/dev/tty; fi
  IFS= read -r answer </dev/tty || answer=
  printf '%s' "${answer:-$2}"
}

ask_secret() {
  [ "$ASSUME_YES" = 1 ] && return
  [ -r /dev/tty ] || die "no terminal to ask \"$1\"; pass it as a flag (see --help)"
  printf '%s: ' "$1" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r answer </dev/tty || answer=
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

fetch() { # fetch <url> <file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "need curl or wget to download $1"
  fi
}

env_get() { # env_get <key> -> value from the existing .env, or nothing
  [ -f "$DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1
}

# --- the host ---------------------------------------------------------------------------------

step "Checking this host"

[ "$(uname -s)" = Linux ] ||
  die "gangway needs a Linux Docker host: previews are reached over the host's own network, which Docker Desktop does not share"
command -v docker >/dev/null 2>&1 || die "Docker is not installed: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 ||
  die "cannot talk to Docker; run as root or as a user in the docker group"
docker compose version >/dev/null 2>&1 ||
  die "the Docker Compose plugin is missing (docker-compose-plugin): https://docs.docker.com/compose/install/linux/"
say "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null), $(docker compose version --short 2>/dev/null)"

# The compose file names the container `gangway`: one per host. Anything else by that name is not ours.
if docker inspect gangway >/dev/null 2>&1; then
  owner=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' gangway 2>/dev/null || true)
  [ "$owner" = "$DIR" ] ||
    die "a container named gangway already exists (from ${owner:-outside compose}); pass --dir for that install, or remove it first"
fi

UPGRADE=0
[ -f "$DIR/.env" ] && UPGRADE=1

# --- settings ---------------------------------------------------------------------------------

if [ "$UPGRADE" = 1 ]; then
  step "Upgrading the gangway in $DIR (its .env is kept)"
  DOMAIN=$(env_get GANGWAY_BASE_DOMAIN)
  if [ "$(env_get GANGWAY_TLS_MODE)" = acme ]; then TLS=acme; else TLS=proxy; fi
  [ -n "$IMAGE" ] || IMAGE=$(env_get GANGWAY_IMAGE)
else
  step "Settings"
  [ -n "$DOMAIN" ] || DOMAIN=$(ask "Base domain for previews (e.g. preview.example.com)" "")
  [ -n "$DOMAIN" ] || die "a base domain is required (--domain)"
  case "$DOMAIN" in
    *[!a-z0-9.-]* | .* | *. | *..*) die "\"$DOMAIN\" is not a domain name (lowercase, like preview.example.com)" ;;
  esac

  if [ -z "$TLS" ]; then
    say ""
    say "Who holds port 443 and the wildcard certificate for *.$DOMAIN?"
    say "  proxy  a reverse proxy already on this host (Nginx Proxy Manager, Caddy, Traefik, ...)"
    say "  acme   gangway itself, with a Let's Encrypt certificate over Cloudflare DNS"
    TLS=$(ask "proxy or acme" "acme")
  fi
  case "$TLS" in proxy | acme) ;; *) die "--tls must be proxy or acme, not \"$TLS\"" ;; esac

  if [ "$TLS" = acme ]; then
    [ -n "$CF_TOKEN" ] || CF_TOKEN=$(ask_secret "Cloudflare API token with Zone:DNS:Edit on $DOMAIN")
    [ -n "$CF_TOKEN" ] || die "acme needs a Cloudflare API token (--cf-token)"
    [ -n "$ACME_EMAIL" ] || ACME_EMAIL=$(ask "Email for Let's Encrypt notices (optional)" "")
  fi
fi

# --- preflight --------------------------------------------------------------------------------

step "Checking DNS and ports"

# Any name under the wildcard must resolve here; a random one proves it is the wildcard.
probe="gw-check-$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n').$DOMAIN"
if command -v getent >/dev/null 2>&1; then
  base_ip=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n 1)
  wild_ip=$(getent hosts "$probe" | awk '{print $1}' | head -n 1)
  if [ -n "$base_ip" ] && [ -n "$wild_ip" ]; then
    say "$DOMAIN -> $base_ip, *.$DOMAIN -> $wild_ip"
  else
    [ -n "$base_ip" ] || warn "$DOMAIN does not resolve; add a DNS record pointing it at this host"
    [ -n "$wild_ip" ] || warn "*.$DOMAIN does not resolve; add a wildcard DNS record pointing it at this host"
    say "gangway starts anyway, but previews are unreachable until DNS points here."
  fi
fi

port_busy() { # port_busy <port>: something other than our gangway listens on it
  command -v ss >/dev/null 2>&1 || return 1
  ss -Hltn "sport = :$1" 2>/dev/null | grep -q . || return 1
  # Our own gangway, on an upgrade, is allowed to hold it.
  [ "$UPGRADE" = 1 ] && docker inspect gangway >/dev/null 2>&1 && return 1
  return 0
}

if [ "$TLS" = acme ]; then
  for p in 443 80; do
    ! port_busy "$p" || die "port $p is already in use; with --tls acme gangway needs 443 and 80 (or use --tls proxy)"
  done
  if [ -n "$CF_TOKEN" ]; then
    verify=$(mktemp)
    if curl -fsS -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify -o "$verify" 2>/dev/null &&
      grep -q '"success": *true' "$verify"; then
      say "Cloudflare token is valid"
    else
      rm -f "$verify"
      die "Cloudflare rejected the API token"
    fi
    rm -f "$verify"
  fi
else
  # Behind a proxy gangway listens on the docker0 gateway, where the proxy's containers reach it.
  GATEWAY=$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
  SUBNET=$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)
  [ -n "$GATEWAY" ] || GATEWAY=172.17.0.1
  [ -n "$SUBNET" ] || SUBNET=172.17.0.0/16
  [ "$UPGRADE" = 1 ] || ! port_busy 8443 || die "port 8443 is already in use"
fi

# --- files ------------------------------------------------------------------------------------

step "Writing $DIR"

umask 077
mkdir -p "$DIR/state"

if [ -n "$COMPOSE_FILE_SRC" ]; then
  cp "$COMPOSE_FILE_SRC" "$DIR/compose.yaml.new"
else
  case "$VERSION" in
    latest) url="https://github.com/$REPO/releases/latest/download/compose.yaml" ;;
    [0-9]*) url="https://github.com/$REPO/releases/download/v$VERSION/compose.yaml" ;;
    # edge and other unreleased tags come from master.
    *) url="https://raw.githubusercontent.com/$REPO/master/compose.yaml" ;;
  esac
  fetch "$url" "$DIR/compose.yaml.new"
fi
chmod 644 "$DIR/compose.yaml.new"
mv "$DIR/compose.yaml.new" "$DIR/compose.yaml"
say "compose.yaml"

set_env() { # set_env <key> <value>: replace the line, or append it
  if grep -q "^$1=" "$DIR/.env" 2>/dev/null; then
    tmp=$(mktemp "$DIR/.env.XXXXXX")
    awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$DIR/.env" >"$tmp"
    mv "$tmp" "$DIR/.env"
  else
    printf '%s=%s\n' "$1" "$2" >>"$DIR/.env"
  fi
}

if [ "$UPGRADE" = 0 ]; then
  token="gw_$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  {
    say "# Written by install.sh on $(date -u +%Y-%m-%d). compose.yaml documents every setting."
    say "GANGWAY_ADMIN_TOKEN=$token"
    say "GANGWAY_BASE_DOMAIN=$DOMAIN"
    say "GANGWAY_INSTANCE=main"
    say "GANGWAY_STATE_PATH=$DIR/state"
    # Report, not stop: on a host with other workloads, look before gangway touches anything.
    say "GANGWAY_RECONCILE_ORPHANS=report"
  } >"$DIR/.env"
  if [ "$TLS" = acme ]; then
    {
      say "GANGWAY_TLS_MODE=acme"
      say "GANGWAY_LISTEN_ADDRESS=::"
      say "GANGWAY_LISTEN_PORT=443"
      say "GANGWAY_LISTEN_HTTP_PORT=80"
      say "GANGWAY_TRUSTED_PROXIES="
      say "GANGWAY_CF_API_TOKEN=$CF_TOKEN"
      say "GANGWAY_ACME_EMAIL=$ACME_EMAIL"
      say "GANGWAY_ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory"
    } >>"$DIR/.env"
  else
    {
      say "GANGWAY_TLS_MODE=selfsigned"
      say "GANGWAY_LISTEN_ADDRESS=$GATEWAY"
      say "GANGWAY_TRUSTED_PROXIES=$SUBNET"
    } >>"$DIR/.env"
  fi
fi
[ -z "$IMAGE" ] || set_env GANGWAY_IMAGE "$IMAGE"
set_env GANGWAY_TAG "$VERSION"
chmod 600 "$DIR/.env"
say ".env (mode 600; holds the admin token)"

# --- start ------------------------------------------------------------------------------------

step "Starting gangway"

compose() { docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" "$@"; }

[ "$SKIP_PULL" = 1 ] || compose pull --quiet
started=$(date +%s)
compose up -d --remove-orphans

printf 'Waiting for it to serve'
i=0
status=
while [ $i -lt 90 ]; do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' gangway 2>/dev/null || true)
  [ "$status" = healthy ] && break
  [ "$status" = exited ] || [ "$status" = dead ] && break
  printf '.'
  sleep 2
  i=$((i + 1))
done
printf '\n'
if [ "$status" != healthy ]; then
  compose logs --tail 40 gangway >&2 || true
  die "gangway did not become healthy (status: ${status:-unknown}); the log is above, the full one is: docker logs gangway"
fi

# --- next steps -------------------------------------------------------------------------------

# Printed on every start until the first account exists; only this run's link works.
setup=$(docker logs --since "$started" gangway 2>&1 | grep -o 'https://[^ ]*/setup?token=[^ ]*' | tail -n 1 || true)

step "gangway is running"
say "  UI:     https://app.$DOMAIN"
say "  Config: $DIR/.env   State: $DIR/state"

if [ "$TLS" = proxy ] && [ "$UPGRADE" = 0 ]; then
  cat <<EOF

Point your reverse proxy at gangway:
  hosts:     $DOMAIN  and  *.$DOMAIN   (the wildcard certificate, websockets on)
  upstream:  https://$GATEWAY:8443     (self-signed; do not verify it)
  nginx:     proxy_read_timeout 600s; proxy_send_timeout 600s;
             client_max_body_size 512m; proxy_request_buffering off;
EOF
fi
if [ "$TLS" = acme ] && [ "$UPGRADE" = 0 ]; then
  say ""
  say "The first certificate takes a minute or two; until then browsers see a temporary one."
fi

if [ -n "$setup" ]; then
  cat <<EOF

Create the first admin account (one use; the link changes if gangway restarts first):

    $setup

EOF
elif [ "$UPGRADE" = 0 ]; then
  say ""
  say "Find the first-admin link with: docker logs gangway 2>&1 | grep setup"
fi
say "Upgrade later by running this script again."
