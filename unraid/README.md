# gangway on Unraid

| Template                               | Previews run              |
| -------------------------------------- | ------------------------- |
| [`gangway-inabox`](gangway-inabox.xml) | in a Debian VM it creates |
| [`gangway`](gangway.xml)               | on Unraid's own Docker    |

Add one with **Docker → Add Container**, pasting the template's raw URL into **Template**. How
each one works, its modes and settings are in the docs:
**[gangway.sh/docs/install/unraid](https://gangway.sh/docs/install/unraid/)**.

[`inabox/`](inabox/) is the gangway-inabox container: it creates the VM through libvirt, installs
gangway in it with [`vm/cloud-init.yaml`](../vm/cloud-init.yaml), and serves a status page.
