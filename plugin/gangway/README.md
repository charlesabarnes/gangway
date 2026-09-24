# gangway plugin for Claude Code and Codex

Ship what Claude would normally make as an artifact to a real HTTPS URL on your gangway server, and keep iterating on it at the same URL.

- **MCP server**: your gangway's `mcp.<base>` surface (`deploy`, `status`, `logs`, `destroy`, and `catalog`, the artifact.md guide and templates).
- **`/gangway:generate-artifact [what to build]`**: the fast path. Write each file once, ship it with `files` or upload by reference, check the routes in the deploy answer, and patch in place.

## Install

One line in a terminal, with your server's MCP URL:

```sh
claude plugin marketplace add charlesabarnes/gangway && claude plugin install gangway@gangway --config mcp_url=https://mcp.preview.example.com/
```

Or inside Claude Code: `/plugin marketplace add charlesabarnes/gangway`, then `/plugin install gangway@gangway`, which asks for the URL. Either way, run `/mcp` afterwards and sign in to `gangway` (OAuth, on your server's consent page). Update later with `claude plugin marketplace update gangway`.

To try a local checkout without installing: `claude --plugin-dir ./plugin/gangway`.

If you already added gangway as a user-level MCP server, remove it (`claude mcp remove gangway`), or you will see every tool twice.

## Codex

```sh
codex mcp add gangway --url https://mcp.preview.example.com/     # signs you in on your server
codex plugin marketplace add charlesabarnes/gangway --sparse .agents --sparse plugin && codex plugin add gangway@gangway   # optional: the skill
```

## Any other agent

Nothing to install: point any MCP client at your server. It explains its workflow on connect and offers a `generate-artifact` prompt. Your gangway's **Account → Connect an agent** page shows the exact commands and install links for Claude Code, Codex, Cursor and VS Code, with your URL filled in.

## Needs

A gangway server whose MCP `deploy` tool supports `upload` and `check`, and whose `logs` tool supports runtime logs. On an older server the skill still works with `files`, but a rebuild needs a credential with `previews.update`.
