# Security

## Reporting a vulnerability

Report it privately, not in a public issue:

- GitHub: **Security → Report a vulnerability** on this repository, or
- email security@gangway.sh.

You will get a reply within a few days. Please give us a reasonable time to ship a fix before you
disclose it.

## Supported versions

Only the latest release gets security fixes.

## Threat model

gangway talks to the Docker socket, which is root on its host, and treats preview code as
hostile. The [Security](README.md#security) section of the README describes what that means for
accounts, previews and networks.
