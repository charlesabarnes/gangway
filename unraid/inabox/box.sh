#!/bin/sh
# gangway in a box: creates a Debian VM on this Unraid server that runs gangway, then shows its
# address and first-admin link on a small status page. Previews run inside the VM, so they never
# touch Unraid's own Docker. Stopping this container leaves the VM running; it is an ordinary VM
# in Unraid's VM tab. Starting it again starts the VM if it is off, and upgrades gangway in it
# to GANGWAY_VERSION with the installer, which rolls back on its own if the new one is unhealthy.
set -eu

VM_NAME=${VM_NAME:-gangway}
VM_CPUS=${VM_CPUS:-2}
VM_MEMORY_MB=${VM_MEMORY_MB:-4096}
VM_DISK=${VM_DISK:-40G}
VM_NETWORK=${VM_NETWORK:-}
GANGWAY_MODE=${GANGWAY_MODE:-proxy}
GANGWAY_DOMAIN=${GANGWAY_DOMAIN:-}
GANGWAY_PROXY_FROM=${GANGWAY_PROXY_FROM:-}
GANGWAY_CF_TOKEN=${GANGWAY_CF_TOKEN:-}
GANGWAY_ACME_EMAIL=${GANGWAY_ACME_EMAIL:-}
GANGWAY_VERSION=${GANGWAY_VERSION:-latest}
GANGWAY_INSTALLER=${GANGWAY_INSTALLER:-https://gangway.sh/install}
SSH_KEY=${SSH_KEY:-}
IMAGE_URL=${IMAGE_URL:-https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2}
STATUS_PORT=${STATUS_PORT:-9124}

DOMAINS=/domains # the Domains share; HOST_DOMAINS is the same folder as the host names it
WWW=/www
export LIBVIRT_DEFAULT_URI=qemu:///system

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() {
  log "error: $*"
  status_page "error" "$*"
  # Stay up, so the message stays on the status page and in the log instead of a restart loop.
  exec sleep infinity
}
# What the VM reports (its address, the URL, the setup link) is escaped like the console: a
# compromised VM must not get markup onto a page this host serves.
html() { sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'"; s/'/\\&#39;/g"; }

# --- the host ---------------------------------------------------------------------------------

# libvirt writes the VM's paths as the host sees them, so find where /domains comes from.
host_domains() {
  curl -fsS --unix-socket /var/run/docker.sock "http://docker/containers/$(hostname)/json" 2>/dev/null |
    jq -r '.Mounts[] | select(.Destination == "/domains") | .Source' 2>/dev/null
}

default_network() {
  [ -n "$VM_NETWORK" ] && { printf '%s' "$VM_NETWORK"; return; }
  # Unraid's VM Manager keeps its default bridge here.
  net=$(sed -n 's/^BRNAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /boot/config/domain.cfg 2>/dev/null | tail -n 1)
  printf '%s' "${net:-br0}"
}

# The Unraid server's own address: where a reverse proxy on it connects to the VM from.
host_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }'
}

wait_for_libvirt() {
  i=0
  until virsh version >/dev/null 2>&1; do
    [ $i = 0 ] && log "waiting for the VM service (Settings > VM Manager > Enable VMs)"
    status_page "waiting" "Waiting for Unraid's VM service. Turn it on in Settings > VM Manager."
    i=$((i + 1))
    sleep 10
  done
}

# --- the VM -----------------------------------------------------------------------------------

install_args() {
  case "$GANGWAY_MODE" in
    lan) printf -- '--lan' ;;
    proxy)
      [ -n "$GANGWAY_DOMAIN" ] || die "proxy mode needs a domain (GANGWAY_DOMAIN)"
      printf -- '--tls proxy --domain %s --listen :: --trusted-proxies %s' "$GANGWAY_DOMAIN" "${GANGWAY_PROXY_FROM:-$(host_ip)/32}"
      ;;
    acme)
      [ -n "$GANGWAY_DOMAIN" ] || die "acme mode needs a domain (GANGWAY_DOMAIN)"
      [ -n "$GANGWAY_CF_TOKEN" ] || die "acme mode needs a Cloudflare API token (GANGWAY_CF_TOKEN)"
      printf -- '--tls acme --domain %s --cf-token %s' "$GANGWAY_DOMAIN" "$GANGWAY_CF_TOKEN"
      [ -z "$GANGWAY_ACME_EMAIL" ] || printf -- ' --acme-email %s' "$GANGWAY_ACME_EMAIL"
      ;;
    *) die "GANGWAY_MODE must be lan, proxy or acme, not \"$GANGWAY_MODE\"" ;;
  esac
  printf -- ' --version %s' "$GANGWAY_VERSION"
}

# The same user-data as vm/cloud-init.yaml, with this template's settings filled in.
user_data() {
  args=$(install_args)
  awk -v args="$args" -v installer="$GANGWAY_INSTALLER" -v name="$VM_NAME" '
    /^hostname: / { print "hostname: " name; next }
    /^      GANGWAY_ARGS=/ { print "      GANGWAY_ARGS=\"" args "\""; print "      GANGWAY_INSTALLER=\"" installer "\""; next }
    { print }' /usr/share/gangway/cloud-init.yaml
  if [ -n "$SSH_KEY" ]; then
    printf 'ssh_authorized_keys:\n  - %s\n' "$SSH_KEY"
  fi
}

domain_xml() { # domain_xml <host dir>
  cat <<XML
<domain type='kvm'>
  <name>$VM_NAME</name>
  <metadata>
    <vmtemplate xmlns="http://unraid" name="Linux" icon="gangway.png" os="linux"/>
  </metadata>
  <memory unit='MiB'>$VM_MEMORY_MB</memory>
  <vcpu placement='static'>$VM_CPUS</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
  </os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough' check='none' migratable='on'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>restart</on_crash>
  <devices>
    <emulator>/usr/local/sbin/qemu</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='writeback' discard='unmap'/>
      <source file='$1/vdisk1.qcow2'/>
      <target dev='vda' bus='virtio'/>
      <boot order='1'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='$1/seed.iso'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
    <interface type='bridge'>
      <source bridge='$(default_network)'/>
      <model type='virtio'/>
    </interface>
    <serial type='file'>
      <source path='$1/console.log' append='on'/>
      <target type='isa-serial' port='0'/>
    </serial>
    <console type='file'>
      <source path='$1/console.log' append='on'/>
      <target type='serial' port='0'/>
    </console>
    <channel type='unix'>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
    </channel>
    <graphics type='vnc' port='-1' autoport='yes' websocket='-1' listen='0.0.0.0'/>
    <video><model type='qxl'/></video>
    <memballoon model='virtio'/>
    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>
  </devices>
</domain>
XML
}

create_vm() {
  dir=$DOMAINS/$VM_NAME
  host_dir=$HOST_DOMAINS/$VM_NAME
  [ ! -e "$dir/vdisk1.qcow2" ] || die "$host_dir/vdisk1.qcow2 exists but no VM named $VM_NAME does; remove the folder, or set VM_NAME"
  mkdir -p "$dir"

  log "downloading $IMAGE_URL"
  status_page "creating" "Downloading the Debian cloud image."
  curl -fsSL "$IMAGE_URL" -o "$dir/base.qcow2.part" || die "could not download $IMAGE_URL"
  mv "$dir/base.qcow2.part" "$dir/base.qcow2"
  qemu-img convert -O qcow2 "$dir/base.qcow2" "$dir/vdisk1.qcow2"
  rm -f "$dir/base.qcow2"
  qemu-img resize -q "$dir/vdisk1.qcow2" "$VM_DISK"

  log "writing the first-boot settings"
  seed=$(mktemp -d)
  user_data >"$seed/user-data"
  printf 'instance-id: %s-%s\nlocal-hostname: %s\n' "$VM_NAME" "$(date +%s)" "$VM_NAME" >"$seed/meta-data"
  xorriso -as genisoimage -quiet -output "$dir/seed.iso" -volid cidata -joliet -rock "$seed/user-data" "$seed/meta-data"
  rm -rf "$seed"
  # The seed holds the install settings, a Cloudflare token among them; only root reads it.
  chmod 600 "$dir/seed.iso"

  [ -d /icons ] && cp /usr/share/gangway/gangway.png /icons/gangway.png 2>/dev/null || true
  domain_xml "$host_dir" >"$dir/$VM_NAME.xml"
  virsh define "$dir/$VM_NAME.xml" >/dev/null || die "libvirt refused the VM definition in $host_dir/$VM_NAME.xml"
  log "created VM $VM_NAME ($VM_CPUS CPUs, $VM_MEMORY_MB MB, $VM_DISK disk, on $(default_network))"
}

vm_state() { virsh domstate "$VM_NAME" 2>/dev/null | head -n 1; }

# --- inside the VM, through the guest agent ---------------------------------------------------

guest() { # guest <shell command>: its output, or nothing if the agent is not up yet
  pid=$(virsh qemu-agent-command "$VM_NAME" "$(jq -nc --arg c "$1" \
    '{execute:"guest-exec",arguments:{path:"/bin/sh",arg:["-c",$c],"capture-output":true}}')" 2>/dev/null |
    jq -r '.return.pid' 2>/dev/null) || return 0
  [ -n "$pid" ] && [ "$pid" != null ] || return 0
  i=0
  while [ $i -lt 30 ]; do
    out=$(virsh qemu-agent-command "$VM_NAME" "{\"execute\":\"guest-exec-status\",\"arguments\":{\"pid\":$pid}}" 2>/dev/null) || return 0
    if [ "$(printf '%s' "$out" | jq -r '.return.exited')" = true ]; then
      printf '%s' "$out" | jq -r '.return["out-data"] // empty' | base64 -d 2>/dev/null
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
}

# One line of JSON about the gangway in the VM: where it answers and whether setup is pending.
PROBE='env=/opt/gangway/.env
[ -f "$env" ] || { echo "{}"; exit 0; }
get() { sed -n "s/^$1=//p" "$env" | tail -n 1; }
d=$(get GANGWAY_BASE_DOMAIN) p=$(get GANGWAY_LISTEN_PORT) pub=$(get GANGWAY_PUBLIC_PORT)
s=$(curl -sk --max-time 5 --resolve "api.$d:$p:127.0.0.1" "https://api.$d:$p/v1/auth/session" || true)
link=$(docker logs gangway 2>&1 | grep -o "https://[^ ]*/setup?token=[^ ]*" | tail -n 1)
printf "{\"domain\":\"%s\",\"port\":\"%s\",\"publicPort\":\"%s\",\"session\":%s,\"setup\":\"%s\"}\n" "$d" "$p" "$pub" "${s:-null}" "$link"'

vm_ip() {
  virsh domifaddr "$VM_NAME" --source agent 2>/dev/null |
    awk '$3 == "ipv4" && $4 !~ /^127\./ && $1 !~ /^(docker|br-|veth)/ { sub(/\/.*/, "", $4); print $4; exit }'
}

# --- the status page --------------------------------------------------------------------------

status_page() { # status_page <state> <message> [url] [setup link] [ip]
  mkdir -p "$WWW"
  {
    cat <<HTML
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10">
<title>gangway in a box</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f}
h1{font-size:1.3rem}dt{color:#666;font-size:.85rem;margin-top:.8rem}dd{margin:0}a{color:#0a5bd8}
pre{background:#f4f4f5;padding:.8rem;overflow:auto;font-size:12px;max-height:22rem}
.setup{background:#fff7e0;border:1px solid #f0d890;padding:.8rem;border-radius:6px;margin-top:1rem}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}pre{background:#1c1c1e}a{color:#6aa9ff}.setup{background:#2a2410;border-color:#6b5a20}}</style>
</head><body><h1>gangway in a box</h1><dl>
<dt>VM</dt><dd>$(printf '%s' "$VM_NAME" | html) &middot; $(printf '%s' "$1" | html)${5:+ &middot; $(printf '%s' "$5" | html)}</dd>
<dt>Status</dt><dd>$(printf '%s' "$2" | html)</dd>
HTML
    if [ -n "${3:-}" ]; then
      url=$(printf '%s' "$3" | html)
      printf '<dt>gangway</dt><dd><a href="%s">%s</a></dd>\n' "$url" "$url"
    fi
    printf '</dl>\n'
    if [ -n "${4:-}" ]; then
      link=$(printf '%s' "$4" | html)
      printf '<div class="setup"><strong>Create the first admin account.</strong> This link works once, until gangway restarts:<br><a href="%s">%s</a></div>\n' "$link" "$link"
    fi
    if [ -f "$DOMAINS/$VM_NAME/console.log" ]; then
      printf '<dt>Console</dt><pre>'
      tail -n 40 "$DOMAINS/$VM_NAME/console.log" | tr -d '\r' | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | html
      printf '</pre>\n'
    fi
    printf '</body></html>\n'
  } >"$WWW/index.html.new"
  mv "$WWW/index.html.new" "$WWW/index.html"
}

# --- main -------------------------------------------------------------------------------------

mkdir -p "$WWW"
status_page "starting" "Starting."
httpd -p "$STATUS_PORT" -h "$WWW"
trap 'log "stopping; the VM keeps running"; exit 0' TERM INT

[ -d "$DOMAINS" ] || die "the Domains share is not mounted at /domains"
HOST_DOMAINS=$(host_domains)
HOST_DOMAINS=${HOST_DOMAINS:-/mnt/user/domains}
wait_for_libvirt

CREATED=0
if [ -z "$(vm_state)" ]; then
  create_vm
  CREATED=1
fi
if [ "$(vm_state)" != running ]; then
  log "starting VM $VM_NAME"
  virsh start "$VM_NAME" >/dev/null || die "the VM would not start; see its log in the VM tab"
fi

# A new VM's first boot installs gangway itself; an existing one is upgraded once the agent answers.
UPGRADED=$CREATED
UPGRADE="curl -fsSL '$GANGWAY_INSTALLER' | sh -s -- --yes --version '$GANGWAY_VERSION'"
last=
announced=
while :; do
  state=$(vm_state)
  ip= url= setup= msg=
  if [ "$state" = running ]; then
    ip=$(vm_ip)
    info=$(guest "$PROBE" | tail -n 1)
    domain=$(printf '%s' "$info" | jq -r '.domain // empty' 2>/dev/null || true)
    if [ -z "$ip" ]; then
      msg="Booting. The first boot installs Docker and gangway, which takes a few minutes."
    elif [ -z "$domain" ]; then
      msg="Installing Docker and gangway; the console below shows how far it is."
    else
      if [ "$UPGRADED" = 0 ]; then
        log "running the installer in the VM for gangway $GANGWAY_VERSION; its log is /var/log/gangway-upgrade.log there"
        guest "nohup sh -c \"$UPGRADE\" >/var/log/gangway-upgrade.log 2>&1 </dev/null &" >/dev/null
        UPGRADED=1
      fi
      pub=$(printf '%s' "$info" | jq -r '.publicPort // empty')
      url="https://app.$domain"
      [ -z "$pub" ] || [ "$pub" = 443 ] || url="$url:$pub"
      if [ "$(printf '%s' "$info" | jq -r '.session.setupRequired // false')" = true ]; then
        setup=$(printf '%s' "$info" | jq -r '.setup // empty')
        msg="Running. Create the first admin account with the link below."
      elif [ "$(printf '%s' "$info" | jq -r '.session | type')" = object ]; then
        msg="Running."
      else
        msg="Installed, but gangway is not answering yet."
      fi
    fi
  else
    msg="The VM is ${state:-gone}. Start it from the VM tab, or restart this container."
  fi
  status_page "${state:-missing}" "$msg" "$url" "$setup" "$ip"
  now="$state $ip $url $msg"
  if [ "$now" != "$last" ]; then
    log "$msg${ip:+ (VM at $ip)}${url:+ $url}"
    last=$now
  fi
  if [ -n "$setup" ] && [ "$setup" != "$announced" ]; then
    log "first admin: $setup"
    announced=$setup
  fi
  sleep 15 &
  wait $!
done
