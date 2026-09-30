---
title: Upgrades and backups
description: Upgrade gangway, roll back, and where its data lives.
---

## Upgrade

Run the installer again. It keeps your settings, pulls the new image and starts it:

```sh
curl -fsSL gangway.sh/install | sh
```

gangway backs its database up before it migrates. If the new version does not come up healthy,
and stay up, the installer puts the previous image and that backup back on its own. To undo the
last upgrade by hand:

```sh
curl -fsSL gangway.sh/install | sh -s -- --rollback
```

`--version 0.3.3` pins a version instead of `latest`. gangway checks GitHub once a day for a newer
release and shows it in the dashboard; `GANGWAY_UPDATE_CHECK=false` stops that.

On Unraid, **Update** in the Docker tab upgrades the `gangway` template. For **gangway-inabox**,
**Restart** (or **Update**) the container: it runs the installer inside the VM. See
[Unraid](/docs/install/unraid/#day-to-day).

## Where the data is

Everything lives in the state folder: `/opt/gangway/state` for an installer install on Linux,
`/mnt/user/appdata/gangway` on Unraid.

| Path                            | Holds                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| `gangway.db`                    | the SQLite database: previews, accounts, settings            |
| `secrets.key`                   | the key that encrypts stored secrets; back it up with the db |
| `backups/`                      | the database from before each migration                      |
| `dev-ca/`                       | the CA behind gangway's self-signed certificates             |
| `uploads/`, `sources/`, `logs/` | deployed sources and preview logs                            |

To back up, copy the state folder while gangway is stopped, or copy `gangway.db` with SQLite's
`.backup` while it runs, together with `secrets.key`. Without `secrets.key`, stored secrets
cannot be read.
