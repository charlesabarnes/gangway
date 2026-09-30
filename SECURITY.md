# Security

## Reporting a vulnerability

Report it privately, not in a public issue:

- GitHub: **Security → Report a vulnerability** on this repository, or
- email security@gangway.sh.

You will get a reply within a few days. Please give us a reasonable time to ship a fix before you
disclose it.

## How fixes are disclosed

Every security fix ships with a published GitHub security advisory that says what was affected,
which versions, and how to upgrade, with a CVE where one applies. The release notes link to it.
There are no silent security fixes.

## Supported versions

Only the latest release gets security fixes.

## Threat model

gangway talks to the Docker socket, which is root on its host, and treats preview code as
hostile. [Security](https://gangway.sh/docs/reference/security/) in the docs describes what that
means for accounts, previews and networks.
