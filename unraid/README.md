# gangway on Unraid

Two templates, one per way to run it.

| Template                               | Previews run              | Needs                                     |
| -------------------------------------- | ------------------------- | ----------------------------------------- |
| [`gangway-inabox`](gangway-inabox.xml) | in a Debian VM it creates | VM Manager on                             |
| [`gangway`](gangway.xml)               | on Unraid's own Docker    | a domain and a reverse proxy, or sslip.io |

Until they are in Community Applications, add one by hand: **Docker > Add Container**, paste the
template's raw URL into **Template**, or save the file to
`/boot/config/plugins/dockerMan/templates-user/my-<name>.xml`.

## gangway-inabox

The container downloads the Debian 13 cloud image, makes a VM from it (`gangway` in the VM tab,
its disk in `domains/gangway/`), and on the VM's first boot installs Docker and gangway with
[`vm/cloud-init.yaml`](../vm/cloud-init.yaml). Its WebUI (port 9124) shows the VM's address, the
install console, and the one-time link that creates the first admin. The first boot takes two
or three minutes.

**Mode** decides how gangway is reached. It is read once, when the VM is created.

- **proxy** (the default): your domain, behind Nginx Proxy Manager or SWAG on this server. Point
  `preview.example.com` and `*.preview.example.com` at the proxy, and proxy both to
  `https://<vm-ip>:8443` with websockets on and a wildcard certificate. Set **Proxy address**
  if the proxy has its own IP on br0.
- **acme**: your domain, with the VM holding ports 80 and 443 and getting a Let's Encrypt
  wildcard certificate over Cloudflare DNS. Point `*.preview.example.com` at the VM.
- **lan**: no domain, to try it out. gangway answers at `https://app.<vm-ip>.sslip.io:8443` on
  your network ([sslip.io](https://sslip.io) is a public DNS service that answers any name with
  the IP in it). Browsers warn once about gangway's own certificate. **Share** on a preview's
  page makes a public link. If the name does not resolve, your router is blocking DNS answers
  that point at private addresses; allow `sslip.io` in it (dnsmasq:
  `rebind-domain-ok=/sslip.io/`).

Stopping the container leaves the VM running. Starting it starts the VM if it is off and runs
the installer in the VM again, which upgrades gangway to **gangway version** and puts the old
version back if the new one does not come up healthy; so **Restart** (or **Update**) in the Docker
tab upgrades gangway. To change mode, or start over, delete the VM and its disk in the VM tab,
then restart the container.

## gangway

gangway on Unraid's own Docker, with host networking and the Docker socket. The defaults put it
behind a reverse proxy container in bridge mode: proxy `preview.example.com` and
`*.preview.example.com` to `https://172.17.0.1:8443` with websockets on, and a wildcard
certificate. The first-admin link is in the container's log.

With no domain, set **Base domain** to `<server-ip-with-dashes>.sslip.io` (for 192.168.1.10,
`192-168-1-10.sslip.io`), **Listen address** to `::`, **Public port** to `8443`, **Trusted
proxies** to empty and **Share links** to `true`, then open
`https://app.192-168-1-10.sslip.io:8443`.

The installer does the same from a terminal on the server (`curl -fsSL gangway.sh/install | sh`),
and writes this template for you.
