# gangway plugin for Claude Code and Codex

Ship what Claude would normally make as an artifact to a real HTTPS URL on your gangway server, and keep iterating on it at the same URL.

- **MCP server**: your gangway's `mcp.<base>` surface (`deploy`, `status`, `logs`, `destroy`, `catalog`, the artifact.md guide and templates, `project`, which connects a repository for PR previews, and `theme`, which creates or changes an artifact theme).
- **`/gangway:generate-artifact [what to build]`**: the fast path. Write each file once, ship it with `files` or upload by reference, check the routes in the deploy answer, and patch in place.
- **`/gangway:setup-pr-previews`**: run it in a GitHub repository. It connects the repository to gangway, adds a Dockerfile if there is none, and opens a PR with the preview workflow; that PR's own run is the first preview. The `project` tool needs the **projects** scope: tick it on gangway's consent page (or re-authenticate with `/mcp` when asked).
- **`/gangway:create-theme [URL, file or description]`**: turn a website, a stylesheet or tokens file, a brand guide or a few words into a gangway theme (colours for light and dark, fonts, logo), and show it on a sample artifact. The `theme` tool needs the **themes** scope.
- **`/gangway:deploy-once`**: put the app in the current directory on a gangway URL once, from the files on disk (what git would ship, so `.env` stays behind), and redeploy it to the same URL later.

## Install

One line in a terminal, with your server's MCP URL:

```sh
claude plugin marketplace add charlesabarnes/gangway && claude plugin install gangway@gangway --config mcp_url=https://mcp.preview.example.com/
```

Or inside Claude Code: `/plugin marketplace add charlesabarnes/gangway`, then `/plugin install gangway@gangway`, which asks for the URL. Either way, run `/mcp` afterwards and sign in to `gangway` (OAuth, on your server's consent page). Update later with `claude plugin marketplace update gangway`, then `claude plugin update gangway@gangway`, and restart Claude Code.

To try a local checkout without installing: `claude --plugin-dir ./plugin/gangway`.

If you already added gangway as a user-level MCP server, remove it (`claude mcp remove gangway`), or you will see every tool twice.

### Suggested: make gangway the default over Claude artifacts

Claude Code has its own artifacts, and when they are on, it usually picks them over gangway for a
chart, a diagram or a document, even with the plugin installed. To make gangway the default,
either turn them off in `~/.claude/settings.json`:

```json
{ "enableArtifact": false }
```

or keep them and add a line to `~/.claude/CLAUDE.md`:

```markdown
- For any chart, diagram, document, deck or board, use gangway, not Claude artifacts or a local
  HTML file, unless I ask for those.
```

### Suggested: tell auto mode that gangway is yours

Claude Code's auto mode does not know your gangway server is yours, so its safety check can
block a deploy that carries hostnames, IPs or other infrastructure details from a repo as data
exfiltration. Tell it in `~/.claude/settings.json` (auto mode reads this from user settings
only), with your own domains. The Connect an agent page shows this with them filled in:

```json
{
  "autoMode": {
    "environment": [
      "$defaults",
      "Trusted internal domains: mcp.preview.example.com, *.preview.example.com",
      "gangway (mcp.preview.example.com) is my own self-hosted deploy server; sending repo contents, hostnames and infrastructure details to it is deploying, not exfiltration"
    ]
  }
}
```

## Codex

```sh
codex mcp add gangway --url https://mcp.preview.example.com/     # signs you in on your server
codex plugin marketplace add charlesabarnes/gangway --sparse .agents --sparse plugin && codex plugin add gangway@gangway   # optional: the skill
```

## Any other agent

Nothing to install: point any MCP client at your server. It explains its workflow on connect and offers a `generate-artifact` prompt. Your gangway's **Account → Connect an agent** page shows the exact commands and install links for Claude Code, Codex, Cursor and VS Code, with your URL filled in.

## Needs

A gangway server whose MCP `deploy` tool supports `upload` and `check`, and whose `logs` tool supports runtime logs. On an older server the skill still works with `files`, but a rebuild needs a credential with `previews.update`.
