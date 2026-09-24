#!/bin/sh
# Installs, upgrades or rolls back gangway on this Docker host.
#
#   curl -fsSL https://github.com/charlesabarnes/gangway/releases/latest/download/install.sh | sh
#
# It works out what it is running on and installs the way that platform expects: an Unraid
# template (icon, Edit form, the Docker tab's Update button), a TrueNAS custom app, a CasaOS
# app, a Synology or plain-Linux compose project, or a local install for Docker Desktop, Colima
# and Podman. It asks for anything a flag did not give, starts gangway and prints the one-time
# link that creates the first admin.
#
# Running it again upgrades. gangway backs its database up before it migrates; if the new
# version does not come up healthy, the installer puts that backup and the previous image back.
# --rollback does the same by hand.
set -eu

REPO=charlesabarnes/gangway
DEFAULT_IMAGE=ghcr.io/charlesabarnes/gangway
ICON=https://raw.githubusercontent.com/charlesabarnes/gangway/master/web/public/apple-touch-icon.png
NAME=gangway
PLATFORM=
DIR=
DOMAIN=
TLS=
CF_TOKEN=
ACME_EMAIL=
VERSION=latest
IMAGE=
PORT=8443
COMPOSE_FILE_SRC=
ASSUME_YES=0
SKIP_PULL=0
ROLLBACK=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --domain <domain>       base domain, e.g. preview.example.com (*.<domain> must point here)
  --tls proxy|acme        proxy: a reverse proxy in front holds 443 and the certificate
                          acme:  gangway holds 443 and gets a wildcard certificate itself
                                 (Let's Encrypt over DNS-01, needs a Cloudflare API token)
  --cf-token <token>      Cloudflare API token that can edit the domain's DNS (acme only)
  --acme-email <email>    contact address for Let's Encrypt (acme only, optional)
  --version <v>           image tag to run, e.g. 0.1.0 or edge (default latest)
  --rollback              put back the version and database from before the last upgrade
  --platform <p>          skip detection: linux, unraid, truenas, casaos, synology, desktop
  --dir <path>            where gangway's files live (default depends on the platform)
  --name <name>           container name, for a second gangway on one host (default gangway)
  --port <port>           port gangway listens on behind a proxy (default 8443)
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
    --version) VERSION=${2:?--version needs a value}; shift ;;
    --rollback) ROLLBACK=1 ;;
    --platform) PLATFORM=${2:?--platform needs a value}; shift ;;
    --dir) DIR=${2:?--dir needs a value}; shift ;;
    --name) NAME=${2:?--name needs a value}; shift ;;
    --port) PORT=${2:?--port needs a value}; shift ;;
    --image) IMAGE=${2:?--image needs a value}; shift ;;
    --compose-file) COMPOSE_FILE_SRC=${2:?--compose-file needs a value}; shift ;;
    --no-pull) SKIP_PULL=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

case "$NAME" in *[!a-z0-9_-]* | "") die "--name is lowercase letters, digits, - and _" ;; esac

# Piped from curl, stdin is the script itself, so questions are read from the terminal.
# /dev/tty exists even without one (cron, CI, setsid); only opening it tells. In a subshell,
# because a failed redirection on `:` ends a POSIX shell outright.
has_tty() { (: </dev/tty) 2>/dev/null; }

ask() { # ask <prompt> <default> -> answer on stdout
  [ "$ASSUME_YES" = 1 ] && { printf '%s' "$2"; return; }
  has_tty || die "no terminal to ask \"$1\"; pass it as a flag (see --help)"
  if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2" >/dev/tty; else printf '%s: ' "$1" >/dev/tty; fi
  IFS= read -r answer </dev/tty || answer=
  printf '%s' "${answer:-$2}"
}

ask_secret() {
  [ "$ASSUME_YES" = 1 ] && return
  has_tty || die "no terminal to ask \"$1\"; pass it as a flag (see --help)"
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

now_ms() { printf '%s000' "$(date +%s)"; }

xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }

# --- the platform -----------------------------------------------------------------------------

step "Checking this host"

command -v docker >/dev/null 2>&1 || die "Docker is not installed: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "cannot talk to Docker; run as root or as a user in the docker group"
engine=$(docker info -f '{{.OperatingSystem}} {{.Name}}' 2>/dev/null || true)

if [ -z "$PLATFORM" ]; then
  if [ "$(uname -s)" != Linux ]; then
    PLATFORM=desktop
  elif [ -f /etc/unraid-version ]; then
    PLATFORM=unraid
  elif command -v midclt >/dev/null 2>&1; then
    PLATFORM=truenas
  elif [ -d /var/lib/casaos ] || command -v casaos >/dev/null 2>&1; then
    PLATFORM=casaos
  elif [ -f /etc/synoinfo.conf ]; then
    PLATFORM=synology
  else
    case "$engine" in
      *"Docker Desktop"* | *colima* | *podman* | *Podman*) PLATFORM=desktop ;;
      *) PLATFORM=linux ;;
    esac
  fi
fi

# MANAGER is who owns the container: compose (a project directory with .env), unraid (a
# dockerMan template) or truenas (a custom app). CONF holds its files, STATE is /state.
case "$PLATFORM" in
  linux)
    LABEL="Linux"
    MANAGER=compose
    DIR=${DIR:-/opt/gangway}
    CONF=$DIR STATE=$DIR/state
    ;;
  synology)
    LABEL="Synology DSM"
    MANAGER=compose
    DIR=${DIR:-/volume1/docker/gangway}
    CONF=$DIR STATE=$DIR/state
    ;;
  casaos)
    LABEL="CasaOS"
    MANAGER=compose
    # CasaOS lists the apps it finds under /var/lib/casaos/apps; data goes under /DATA/AppData.
    DIR=${DIR:-/DATA/AppData/$NAME}
    CONF=/var/lib/casaos/apps/$NAME STATE=$DIR
    ;;
  unraid)
    LABEL="Unraid $(sed -n 's/^version="\(.*\)"/\1/p' /etc/unraid-version 2>/dev/null)"
    MANAGER=unraid
    DIR=${DIR:-/mnt/user/appdata/$NAME}
    CONF=$DIR STATE=$DIR
    TEMPLATE=/boot/config/plugins/dockerMan/templates-user/my-$NAME.xml
    DOCKERMAN=/usr/local/emhttp/plugins/dynamix.docker.manager/scripts
    ;;
  truenas)
    LABEL="TrueNAS SCALE"
    MANAGER=truenas
    if [ -z "$DIR" ]; then
      pool=$(midclt call pool.query 2>/dev/null | python3 -c 'import json,sys; p=json.load(sys.stdin); print(p[0]["name"] if p else "")' 2>/dev/null || true)
      [ -n "$pool" ] || die "no storage pool found; create one, or pass --dir /mnt/<pool>/gangway"
      DIR=/mnt/$pool/$NAME
    fi
    CONF=$DIR STATE=$DIR/state
    ;;
  desktop)
    LABEL="a desktop engine ($engine)"
    MANAGER=compose
    DIR=${DIR:-$HOME/.gangway}
    CONF=$DIR STATE=$DIR/state
    ;;
  *) die "--platform must be linux, unraid, truenas, casaos, synology or desktop" ;;
esac

if [ "$MANAGER" != truenas ]; then
  docker compose version >/dev/null 2>&1 || [ "$MANAGER" = unraid ] ||
    die "the Docker Compose plugin is missing: https://docs.docker.com/compose/install/"
fi
say "$LABEL, Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null)"
case "$PLATFORM" in
  # Written to each platform's conventions but not yet run on one. Reports are welcome.
  unraid | truenas | synology | desktop)
    warn "installing on $LABEL is experimental; if something is off: https://github.com/$REPO/issues"
    ;;
esac

# Anything by this name that this install did not make is not ours to replace.
EXISTS=0
if docker inspect "$NAME" >/dev/null 2>&1; then
  EXISTS=1
  owner=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}{{index .Config.Labels "net.unraid.docker.managed"}}' "$NAME" 2>/dev/null || true)
  case "$MANAGER:$owner" in
    compose:"$CONF" | unraid:dockerman | truenas:*) ;;
    *) die "a container named $NAME already exists (${owner:-not from this installer}); pass --name for a second gangway, or remove it first" ;;
  esac
fi

# --- existing installs ------------------------------------------------------------------------

conf_get() { # conf_get <key>: the value this install runs with, from wherever its manager keeps it
  case "$MANAGER" in
    compose) [ -f "$CONF/.env" ] && sed -n "s/^$1=//p" "$CONF/.env" | tail -n 1 ;;
    *) docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" 2>/dev/null | sed -n "s/^$1=//p" | tail -n 1 ;;
  esac
  return 0
}

case "$MANAGER" in
  compose) [ -f "$CONF/.env" ] && UPGRADE=1 || UPGRADE=0 ;;
  unraid) [ -f "$TEMPLATE" ] && UPGRADE=1 || UPGRADE=0 ;;
  truenas) midclt call app.get_instance "$NAME" >/dev/null 2>&1 && UPGRADE=1 || UPGRADE=0 ;;
esac
[ "$ROLLBACK" = 0 ] || [ "$UPGRADE" = 1 ] || die "there is no gangway installed here to roll back"

if [ "$UPGRADE" = 1 ]; then
  DOMAIN=$(conf_get GANGWAY_BASE_DOMAIN)
  if [ "$(conf_get GANGWAY_TLS_MODE)" = acme ]; then TLS=acme; else TLS=proxy; fi
fi

# --- settings ---------------------------------------------------------------------------------

if [ "$UPGRADE" = 0 ]; then
  step "Settings"
  if [ "$PLATFORM" = desktop ]; then
    # *.localhost resolves to this machine in browsers and curl, so no DNS or certificate to set up.
    DOMAIN=${DOMAIN:-preview.localhost} TLS=local
  else
    [ -n "$DOMAIN" ] || DOMAIN=$(ask "Base domain for previews (e.g. preview.example.com)" "")
    [ -n "$DOMAIN" ] || die "a base domain is required (--domain)"
  fi
  case "$DOMAIN" in
    *[!a-z0-9.-]* | .* | *. | *..*) die "\"$DOMAIN\" is not a domain name (lowercase, like preview.example.com)" ;;
  esac

  if [ -z "$TLS" ]; then
    # NAS web UIs usually hold 80 and 443 already, so a proxy is the likelier setup there.
    case "$PLATFORM" in unraid | truenas | synology | casaos) suggest=proxy ;; *) suggest=acme ;; esac
    say ""
    say "Who holds port 443 and the wildcard certificate for *.$DOMAIN?"
    say "  proxy  a reverse proxy already on this host (Nginx Proxy Manager, Caddy, Traefik, ...)"
    say "  acme   gangway itself, with a Let's Encrypt certificate over Cloudflare DNS"
    TLS=$(ask "proxy or acme" "$suggest")
  fi
  case "$TLS" in proxy | acme | local) ;; *) die "--tls must be proxy or acme, not \"$TLS\"" ;; esac

  if [ "$TLS" = acme ]; then
    [ -n "$CF_TOKEN" ] || CF_TOKEN=$(ask_secret "Cloudflare API token with Zone:DNS:Edit on $DOMAIN")
    [ -n "$CF_TOKEN" ] || die "acme needs a Cloudflare API token (--cf-token)"
    [ -n "$ACME_EMAIL" ] || ACME_EMAIL=$(ask "Email for Let's Encrypt notices (optional)" "")
  fi
fi

# --- preflight --------------------------------------------------------------------------------

port_busy() { # port_busy <port>: something other than our gangway listens on it
  [ "$EXISTS" = 1 ] && return 1
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

if [ "$UPGRADE" = 0 ]; then
  step "Checking DNS and ports"

  if [ "$TLS" != local ] && command -v getent >/dev/null 2>&1; then
    # Any name under the wildcard must resolve here; a random one proves it is the wildcard.
    probe="gw-check-$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n').$DOMAIN"
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

  case "$TLS" in
    acme)
      for p in 443 80; do
        ! port_busy "$p" || die "port $p is already in use; with --tls acme gangway needs 443 and 80 (or use --tls proxy)"
      done
      verify=$(mktemp)
      if curl -fsS -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify -o "$verify" 2>/dev/null &&
        grep -q '"success": *true' "$verify"; then
        rm -f "$verify"
        say "Cloudflare token is valid"
      else
        rm -f "$verify"
        die "Cloudflare rejected the API token"
      fi
      ;;
    proxy)
      # Behind a proxy gangway listens on the docker0 gateway, where the proxy's containers reach it.
      GATEWAY=$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
      SUBNET=$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)
      GATEWAY=${GATEWAY:-172.17.0.1} SUBNET=${SUBNET:-172.17.0.0/16}
      ! port_busy "$PORT" || die "port $PORT is already in use; pick another with --port"
      ;;
    local)
      ! port_busy "$PORT" || die "port $PORT is already in use; pick another with --port"
      ;;
  esac
  say "ok"
fi

# --- configuration ----------------------------------------------------------------------------

# The settings a new install starts with, as KEY=value lines; each manager stores them its own way.
initial_env() {
  say "GANGWAY_ADMIN_TOKEN=gw_$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  say "GANGWAY_BASE_DOMAIN=$DOMAIN"
  say "GANGWAY_INSTANCE=$([ "$NAME" = gangway ] && echo main || echo "$NAME")"
  # Report, not stop: on a host with other workloads, look before gangway touches anything.
  say "GANGWAY_RECONCILE_ORPHANS=report"
  case "$TLS" in
    acme)
      say "GANGWAY_TLS_MODE=acme"
      say "GANGWAY_LISTEN_ADDRESS=::"
      say "GANGWAY_LISTEN_PORT=443"
      say "GANGWAY_LISTEN_HTTP_PORT=80"
      say "GANGWAY_TRUSTED_PROXIES="
      say "GANGWAY_CF_API_TOKEN=$CF_TOKEN"
      say "GANGWAY_ACME_EMAIL=$ACME_EMAIL"
      say "GANGWAY_ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory"
      ;;
    proxy)
      say "GANGWAY_TLS_MODE=selfsigned"
      say "GANGWAY_LISTEN_ADDRESS=$GATEWAY"
      say "GANGWAY_LISTEN_PORT=$PORT"
      say "GANGWAY_TRUSTED_PROXIES=$SUBNET"
      ;;
    local)
      say "GANGWAY_TLS_MODE=selfsigned"
      say "GANGWAY_LISTEN_ADDRESS=::"
      say "GANGWAY_LISTEN_PORT=$PORT"
      say "GANGWAY_PUBLIC_PORT=$PORT"
      say "GANGWAY_TRUSTED_PROXIES="
      ;;
  esac
}

compose_url() {
  case "$VERSION" in
    latest) echo "https://github.com/$REPO/releases/latest/download/compose.yaml" ;;
    [0-9]*) echo "https://github.com/$REPO/releases/download/v$VERSION/compose.yaml" ;;
    # edge, rollback and other unreleased tags come from master.
    *) echo "https://raw.githubusercontent.com/$REPO/master/compose.yaml" ;;
  esac
}

set_env() { # set_env <file> <key> <value>: replace the line, or append it
  if grep -q "^$2=" "$1" 2>/dev/null; then
    tmp=$(mktemp "$1.XXXXXX")
    awk -v k="$2" -v v="$3" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$1" >"$tmp"
    mv "$tmp" "$1"
  else
    printf '%s=%s\n' "$2" "$3" >>"$1"
  fi
}

# --- managers ---------------------------------------------------------------------------------
#
# Each manager can write its configuration, pin the image, start gangway and stop it.

COMPOSE_NAME=compose.yaml
[ "$PLATFORM" = casaos ] && COMPOSE_NAME=docker-compose.yml

# A compose.override.yaml next to the compose file is the user's, and upgrades never touch it.
compose() {
  if [ -f "$CONF/compose.override.yaml" ]; then
    docker compose --project-directory "$CONF" -f "$CONF/$COMPOSE_NAME" -f "$CONF/compose.override.yaml" "$@"
  else
    docker compose --project-directory "$CONF" -f "$CONF/$COMPOSE_NAME" "$@"
  fi
}

fetch_compose() {
  if [ -n "$COMPOSE_FILE_SRC" ]; then
    cp "$COMPOSE_FILE_SRC" "$CONF/$COMPOSE_NAME.new"
  else
    fetch "$(compose_url)" "$CONF/$COMPOSE_NAME.new"
  fi
  if [ "$PLATFORM" = casaos ]; then
    # What the CasaOS dashboard shows for the app.
    cat >>"$CONF/$COMPOSE_NAME.new" <<META

x-casaos:
  architectures: [amd64, arm64]
  main: gangway
  author: charlesabarnes
  developer: gangway
  category: Developer
  icon: $ICON
  title:
    en_us: gangway
  tagline:
    en_us: Preview URLs on your own domain
  description:
    en_us: Gives any containerized app a public HTTPS URL, from a pull request, an agent or a folder.
  scheme: https
  hostname: app.$DOMAIN
  port_map: "443"
  index: /
META
  fi
  chmod 644 "$CONF/$COMPOSE_NAME.new"
  mv "$CONF/$COMPOSE_NAME.new" "$CONF/$COMPOSE_NAME"
}

write_env_file() { # a new install's .env
  {
    say "# Written by install.sh on $(date -u +%Y-%m-%d). compose.yaml documents every setting."
    initial_env
    say "GANGWAY_STATE_PATH=$STATE"
    [ "$NAME" = gangway ] || say "GANGWAY_CONTAINER=$NAME"
  } >"$CONF/.env"
  chmod 600 "$CONF/.env"
}

unraid_template() { # a dockerMan template holding every setting, so the Docker tab can edit them
  webui="https://app.$DOMAIN/"
  cat <<XML
<?xml version="1.0"?>
<Container version="2">
  <Name>$NAME</Name>
  <Repository>$(xml_escape "$1")</Repository>
  <Registry>https://github.com/$REPO/pkgs/container/gangway</Registry>
  <Network>host</Network>
  <MyIP/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support>https://github.com/$REPO/issues</Support>
  <Project>https://github.com/$REPO</Project>
  <Overview>Preview URLs on your own domain for any containerized app, from a pull request, an agent, or a folder dropped in the browser. Update here, or run install.sh again, to upgrade.</Overview>
  <Category>Tools: Network:Web</Category>
  <WebUI>$webui</WebUI>
  <Icon>$ICON</Icon>
  <ExtraParams>--stop-timeout 15</ExtraParams>
  <PostArgs/>
  <CPUset/>
  <DateInstalled>$(date +%s)</DateInstalled>
  <Config Name="State" Target="/state" Default="$STATE" Mode="rw" Description="Database, logs, uploads and backups" Type="Path" Display="always" Required="true" Mask="false">$STATE</Config>
  <Config Name="Docker socket" Target="/var/run/docker.sock" Default="/var/run/docker.sock" Mode="rw" Description="gangway runs previews as containers on this host" Type="Path" Display="advanced" Required="true" Mask="false">/var/run/docker.sock</Config>
XML
  initial_env | while IFS='=' read -r key value; do
    mask=false
    case "$key" in *TOKEN*) mask=true ;; esac
    printf '  <Config Name="%s" Target="%s" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="%s">%s</Config>\n' \
      "$key" "$key" "$mask" "$(xml_escape "$value")"
  done
  say "</Container>"
}

truenas_json() { # <app name or nothing>: the custom app's compose, with .env resolved into it
  compose config | python3 -c '
import json, sys
body = {"custom_compose_config_string": sys.stdin.read()}
if len(sys.argv) > 1:
    body.update(app_name=sys.argv[1], custom_app=True)
print(json.dumps(body))' "$@"
}

write_config() {
  umask 077
  mkdir -p "$CONF" "$STATE"
  case "$MANAGER" in
    compose | truenas)
      fetch_compose
      say "$CONF/$COMPOSE_NAME"
      if [ "$UPGRADE" = 0 ]; then
        write_env_file
        say "$CONF/.env (mode 600; holds the admin token)"
      fi
      ;;
    unraid)
      if [ "$UPGRADE" = 0 ]; then
        unraid_template "$(image_ref)" >"$TEMPLATE"
        say "$TEMPLATE"
      fi
      # The Docker tab starts only what is in this list when the array comes up.
      touch /var/lib/docker/unraid-autostart
      grep -q "^$NAME\( \|$\)" /var/lib/docker/unraid-autostart || say "$NAME" >>/var/lib/docker/unraid-autostart
      ;;
  esac
}

image_ref() { printf '%s:%s' "${IMAGE:-$DEFAULT_IMAGE}" "$VERSION"; }

pin() { # pin <image> <tag>: what the next start runs
  case "$MANAGER" in
    compose | truenas)
      set_env "$CONF/.env" GANGWAY_IMAGE "$1"
      set_env "$CONF/.env" GANGWAY_TAG "$2"
      ;;
    unraid)
      tmp=$(mktemp "$TEMPLATE.XXXXXX")
      sed "s|<Repository>.*</Repository>|<Repository>$(xml_escape "$1:$2")</Repository>|" "$TEMPLATE" >"$tmp"
      mv "$tmp" "$TEMPLATE"
      ;;
  esac
}

start() {
  case "$MANAGER" in
    compose)
      [ "$SKIP_PULL" = 1 ] || compose pull --quiet
      compose up -d --remove-orphans
      ;;
    unraid)
      repo=$(sed -n 's|.*<Repository>\(.*\)</Repository>.*|\1|p' "$TEMPLATE")
      [ "$SKIP_PULL" = 1 ] || docker pull -q "$repo" >/dev/null
      # What the Docker tab's Update and Apply run: remove the container, create it from the template.
      "$DOCKERMAN/rebuild_container" "$NAME"
      ;;
    truenas)
      if midclt call app.get_instance "$NAME" >/dev/null 2>&1; then
        midclt call -j app.update "$NAME" "$(truenas_json)" >/dev/null
        [ "$SKIP_PULL" = 1 ] || midclt call -j app.pull_images "$NAME" '{"redeploy": true}' >/dev/null
      else
        midclt call -j app.create "$(truenas_json "$NAME")" >/dev/null
      fi
      ;;
  esac
}

stop() {
  case "$MANAGER" in
    truenas) midclt call -j app.stop "$NAME" >/dev/null ;;
    *) docker stop "$NAME" >/dev/null 2>&1 || true ;;
  esac
}

wait_healthy() {
  printf 'Waiting for it to serve'
  i=0
  status=
  while [ $i -lt 90 ]; do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$NAME" 2>/dev/null || true)
    [ "$status" = healthy ] && break
    [ "$status" = exited ] || [ "$status" = dead ] && break
    # restart: unless-stopped turns a crash into "restarting", never "exited".
    [ "$(docker inspect -f '{{.RestartCount}}' "$NAME" 2>/dev/null || echo 0)" -ge 3 ] && break
    printf '.'
    sleep 2
    i=$((i + 1))
  done
  [ "$status" = healthy ] || { printf '\n'; return 1; }
  # A version that serves and then crashes must not pass: it has to stay up without restarting.
  started=$(docker inspect -f '{{.State.StartedAt}}' "$NAME")
  sleep 15
  printf '\n'
  [ "$(docker inspect -f '{{.State.StartedAt}} {{.State.Health.Status}}' "$NAME" 2>/dev/null)" = "$started healthy" ]
}

# --- rollback ---------------------------------------------------------------------------------

ROLLBACK_IMAGE=gangway-rollback
MARK="$CONF/.gangway-upgrade"

newest_backup_since() { # the backup gangway took when it migrated after <ms>, if it did
  for f in "$STATE"/backups/gangway-pre-*-*.db; do
    [ -f "$f" ] || continue
    ts=${f##*-}
    ts=${ts%.db}
    [ "$ts" -ge "$1" ] && say "$ts $f"
  done | sort -n | tail -n 1 | cut -d' ' -f2-
}

roll_back() { # roll_back <since-ms>
  docker image inspect "$ROLLBACK_IMAGE:$NAME" >/dev/null 2>&1 ||
    die "the previous image ($ROLLBACK_IMAGE:$NAME) is gone; nothing to roll back to"
  step "Rolling back"
  stop
  backup=$(newest_backup_since "$1")
  if [ -n "$backup" ]; then
    # The failed version's database is kept beside it, not deleted.
    failed="$STATE/gangway.db.failed-$(date +%Y%m%d%H%M%S)"
    for ext in "" -wal -shm; do
      if [ -f "$STATE/gangway.db$ext" ]; then mv "$STATE/gangway.db$ext" "$failed$ext"; fi
    done
    cp "$backup" "$STATE/gangway.db"
    say "restored the database from $backup (the newer one is at $failed)"
  else
    say "the upgrade applied no migrations, so the database stays as it is"
  fi
  pin "$ROLLBACK_IMAGE" "$NAME"
  SKIP_PULL=1
  start
  wait_healthy || die "the previous version did not come up either; see: docker logs $NAME"
  rm -f "$MARK"
}

if [ "$ROLLBACK" = 1 ]; then
  [ -f "$MARK" ] || die "no upgrade to roll back (the installer records one each time it upgrades)"
  roll_back "$(cat "$MARK")"
  step "Rolled back"
  say "gangway runs the version from before the last upgrade, pinned to $ROLLBACK_IMAGE:$NAME."
  say "Run this script again (without --rollback) to upgrade when a fixed version is out."
  exit 0
fi

# --- install or upgrade -----------------------------------------------------------------------

if [ "$UPGRADE" = 1 ]; then
  step "Upgrading the gangway in $CONF (its settings are kept)"
else
  step "Writing $CONF"
fi
write_config

since=$(now_ms)
if [ "$UPGRADE" = 1 ] && [ "$EXISTS" = 1 ]; then
  docker tag "$(docker inspect -f '{{.Image}}' "$NAME")" "$ROLLBACK_IMAGE:$NAME"
  say "$since" >"$MARK"
fi
pin "${IMAGE:-$DEFAULT_IMAGE}" "$VERSION"

step "Starting gangway"
start
if ! wait_healthy; then
  docker logs --tail 40 "$NAME" >&2 2>&1 || true
  if [ "$UPGRADE" = 1 ] && [ -f "$MARK" ]; then
    roll_back "$since"
    die "the new version did not become healthy, so gangway was rolled back to the previous one; its log is above"
  fi
  die "gangway did not become healthy; the log is above, the full one is: docker logs $NAME"
fi

# --- next steps -------------------------------------------------------------------------------

origin="https://app.$DOMAIN"
[ "$TLS" = local ] && origin="https://app.$DOMAIN:$PORT"

step "gangway is running"
say "  UI:      $origin"
case "$MANAGER" in
  compose) say "  Config:  $CONF/.env   State: $STATE" ;;
  unraid) say "  Config:  Docker tab > $NAME > Edit   State: $STATE" ;;
  truenas) say "  Config:  $CONF/.env (edits in the Apps UI are replaced on upgrade)   State: $STATE" ;;
esac

if [ "$TLS" = local ] && ! curl -sk --max-time 5 --resolve "api.$DOMAIN:$PORT:127.0.0.1" "https://api.$DOMAIN:$PORT/healthz" >/dev/null; then
  warn "gangway is up inside Docker but not reachable on this machine's port $PORT"
  say "  Docker Desktop: Settings > Resources > Network > Enable host networking, then run this again."
fi

if [ "$UPGRADE" = 0 ]; then
  if [ "$TLS" = proxy ]; then
    cat <<NEXT

Point your reverse proxy at gangway:
  hosts:     $DOMAIN  and  *.$DOMAIN   (the wildcard certificate, websockets on)
  upstream:  https://$GATEWAY:$PORT     (self-signed; do not verify it)
  nginx:     proxy_read_timeout 600s; proxy_send_timeout 600s;
             client_max_body_size 512m; proxy_request_buffering off;
NEXT
    if [ "$PLATFORM" = synology ]; then
      say "  On DSM: Control Panel > Login Portal > Advanced > Reverse Proxy, with WebSocket headers."
    fi
  fi
  if [ "$TLS" = acme ]; then
    say ""
    say "The first certificate takes a minute or two; until then browsers see a temporary one."
  fi
  if [ "$TLS" = local ]; then
    say ""
    say "Browsers warn about the certificate: it is gangway's own. Its CA is $STATE/dev-ca/ca.pem."
  fi

  # Printed on every start until the first account exists; only this run's link works.
  setup=$(docker logs --since "${since%000}" "$NAME" 2>&1 | grep -o 'https://[^ ]*/setup?token=[^ ]*' | tail -n 1 || true)
  if [ -n "$setup" ]; then
    cat <<NEXT

Create the first admin account (one use; the link changes if gangway restarts first):

    $setup

NEXT
  else
    say ""
    say "Find the first-admin link with: docker logs $NAME 2>&1 | grep setup"
  fi
fi

case "$MANAGER" in
  unraid) say "Upgrade with Update in the Docker tab, or by running this script again." ;;
  *) say "Upgrade by running this script again; --rollback undoes the last upgrade." ;;
esac
