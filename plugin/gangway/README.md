# gangway plugin for Claude Code

Ship what Claude would normally make as an artifact to a real HTTPS URL on your gangway server, and keep iterating on it at the same URL.

- **MCP server**: your gangway's `mcp.<base>` surface (`deploy`, `status`, `logs`, `destroy`).
- **`/gangway:generate-artifact [what to build]`**: the fast path. Write each file once, ship it with `files` or upload by reference, check the routes in the deploy answer, and patch in place.

## Install

From a clone of this repository:

```
/plugin marketplace add /path/to/gangway
/plugin install gangway@gangway
```

When prompted, enter your MCP URL, for example `https://mcp.preview.example.com/`. Then run `/mcp` and sign in to `gangway`. That is OAuth against your server's consent page.

To try it without installing: `claude --plugin-dir ./plugin/gangway`.

If you already added gangway as a user-level MCP server, remove one of the two copies, or you will see every tool twice.

## Needs

A gangway server with ADR-0021: `upload`, `check` and runtime `logs`. On an older server the skill still works with `files`, but a rebuild needs a credential with `previews.update`.
