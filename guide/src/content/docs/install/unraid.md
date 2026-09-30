---
title: Unraid
description: Run gangway on Unraid in its own VM with gangway-inabox, or on Unraid's Docker with the gangway template.
---

There are two templates, one for each way to run gangway.

| Template           | Previews run              | Needs                                     |
| ------------------ | ------------------------- | ----------------------------------------- |
| **gangway-inabox** | in a Debian VM it creates | VM Manager on                             |
| **gangway**        | on Unraid's own Docker    | a domain and a reverse proxy, or sslip.io |

gangway holds the Docker socket, which is root on its host, and runs other people's code. **gangway-inabox**
keeps all of that inside a VM, away from your array and your other containers, so it is the one
to start with.

Both are in Community Applications: open **Apps**, search for **gangway**, and install the one you
want. The templates live in
[charlesabarnes/unraid-templates](https://github.com/charlesabarnes/unraid-templates).

## gangway-inabox

Like Home Assistant in a Box, the container builds a VM and looks after it:

1. It downloads the Debian 13 cloud image and makes a VM from it: **gangway** in the VM tab, with
   its disk in `domains/gangway/`.
2. On the VM's first boot, [cloud-init](/docs/install/vm/) installs Docker and gangway.
3. Its **WebUI** (port 9124) shows the VM's address, the install console, and the one-time link
   that creates the first admin. The first boot takes two or three minutes.

It needs Unraid's VM service (**Settings → VM Manager**) and hardware virtualisation in the BIOS.

### Mode

**Mode** decides how gangway is reached. It is read once, when the VM is created.

- **proxy** _(default)_: your domain, behind Nginx Proxy Manager or SWAG on this server. Point
  `preview.example.com` and `*.preview.example.com` at the proxy, and proxy both to
  `https://<vm-ip>:8443`. See [Reverse proxy](/docs/setup/reverse-proxy/). If the proxy has its
  own IP on br0 rather than running in bridge mode, put that IP in **Proxy address**
  (e.g. `192.168.1.20/32`).
- **acme**: your domain, with the VM holding ports 80 and 443 and getting a Let's Encrypt wildcard
  certificate over Cloudflare DNS. Point `*.preview.example.com` at the VM, and fill in
  **Cloudflare API token**.
- **lan**: no domain, to try it out. gangway answers at `https://app.<vm-ip>.sslip.io:8443` on
  your network. See [lan mode](/docs/install/modes/#lan).

### Day to day

- Stopping the container leaves the VM running. It is an ordinary VM in the VM tab.
- Starting the container starts the VM if it is off, and runs the installer in the VM again. That
  upgrades gangway to **gangway version** (`latest` by default) and puts the old version back if
  the new one does not come up healthy. So **Restart**, or **Update** when the container has an
  update, upgrades gangway.
- To change mode, or start over, delete the VM and its disk in the VM tab, then restart the
  container.

The VM's CPUs, memory (4096 MB), disk (40G), network and an SSH key for the `debian` user are
under **Show more settings**.

## gangway

gangway on Unraid's own Docker, with host networking and the Docker socket. Previews run as
containers beside your others.

The defaults put it behind a reverse proxy container in bridge mode: proxy `preview.example.com`
and `*.preview.example.com` to `https://172.17.0.1:8443`, with websockets on and a wildcard
certificate. Fill in **Base domain**; the first-admin link is in the container's log.

With no domain, set:

| Setting         | Value                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| Base domain     | your server's IP with dashes, then `.sslip.io`: `192-168-1-10.sslip.io` |
| Listen address  | `::`                                                                    |
| Public port     | `8443`                                                                  |
| Trusted proxies | empty                                                                   |
| Share links     | `true`                                                                  |

then open `https://app.192-168-1-10.sslip.io:8443`.

Running the installer from a terminal on the server (`curl -fsSL gangway.sh/install | sh`) sets
up the same template for you.

## Help

Questions, setup help and bugs:
[GitHub issues](https://github.com/charlesabarnes/gangway/issues). Common snags are in
[Troubleshooting](/docs/reference/troubleshooting/).
