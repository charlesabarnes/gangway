# gangway on Unraid

The Community Applications templates, gangway-inabox and gangway, are in
**[charlesabarnes/unraid-templates](https://github.com/charlesabarnes/unraid-templates)**. How each
one works, its modes and settings are in the docs:
**[gangway.sh/docs/install/unraid](https://gangway.sh/docs/install/unraid/)**.

[`inabox/`](inabox/) is the gangway-inabox container: it creates the VM through libvirt, installs
gangway in it with [`vm/cloud-init.yaml`](../vm/cloud-init.yaml), and serves a status page.
