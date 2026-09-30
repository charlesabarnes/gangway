---
title: In a VM
description: Give gangway a VM of its own with a cloud-init file, in Proxmox, Unraid, Multipass or any cloud.
---

gangway holds the Docker socket, which is root on its host, and treats preview code as hostile. On
a machine that does other work, give gangway a VM of its own: a bad preview can then only damage
the VM.

[`vm/cloud-init.yaml`](https://github.com/charlesabarnes/gangway/blob/master/vm/cloud-init.yaml)
turns a stock **Debian 13** or **Ubuntu 24.04** cloud image into a gangway VM on its first boot. It
installs Docker, the QEMU guest agent and unattended upgrades, then runs the installer. It works in
any hypervisor that takes cloud-init user-data: Proxmox, Unraid, libvirt, Multipass, or a cloud
provider. On Unraid, [gangway-inabox](/docs/install/unraid/) does all of this for you.

## Pick the mode

Edit `GANGWAY_ARGS` in the file; the value is passed to the installer:

```yaml
write_files:
  - path: /etc/gangway/install-args
    content: |
      GANGWAY_ARGS="--tls proxy --domain preview.example.com --listen :: --trusted-proxies 192.168.1.10/32"
```

| Mode                          | `GANGWAY_ARGS`                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| behind a proxy on another box | `--tls proxy --domain preview.example.com --listen :: --trusted-proxies <proxy-ip>/32` |
| holds 80/443 itself           | `--tls acme --domain preview.example.com --cf-token <token>`                           |
| no domain, on your network    | `--lan`                                                                                |

`--listen ::` makes gangway answer on the VM's own address, where a proxy on another machine can
reach it. `--trusted-proxies` names that proxy, so gangway believes its `X-Forwarded-For`.

Add your SSH key under `ssh_authorized_keys` to log in to the VM later.

## Example: Multipass

```sh
multipass launch 24.04 --name gangway --cpus 2 --memory 4G --disk 40G --cloud-init cloud-init.yaml
```

## What to expect

The first boot takes two or three minutes. The installer's output, with the first-admin link, goes
to `/var/log/gangway-install.log` and to the serial console.

To upgrade, run the installer again in the VM:

```sh
curl -fsSL gangway.sh/install | sudo sh
```
