---
title: gangway as a Claude artifacts alternative
description: A self-hosted alternative to Claude artifacts, for pages that need a backend, more than one page, your own domain, or an agent other than Claude.
---

[Claude artifacts](https://code.claude.com/docs/en/artifacts) turn what Claude makes into a live
page on claude.ai: a dashboard, an annotated diff, a deck, a small tool. gangway puts the same kind
of thing on a server you run, from Claude or any other agent, and goes on to whole apps.

Anthropic's own docs draw the line: an artifact is "one self-contained page with no backend", and
"for a hosted internal tool with a backend, deploy it on your own infrastructure instead". gangway is
that infrastructure, and it handles the one-page artifacts too.

## Pick Claude artifacts when

- the page is one self-contained page, made in a Claude chat or a signed-in Claude Code session;
- you want people in your Claude organization to comment on it, or edit it through Claude;
- the page should call each viewer's own Claude connectors, or Claude itself, on their plan;
- you want Claude's Slides, Design or Docs editors and their exports to PowerPoint, PDF or Word.

## Pick gangway when

- **it needs a backend.** An artifact is a static page that can only reach its own origin, five CDNs
  and Google Fonts. On gangway it can be a Node, Bun, Python or PHP server with Postgres, MySQL or
  Redis beside it, calling any API it likes.
- **it is more than one page.** Artifacts are one HTML or Markdown file with no relative links.
  gangway serves a whole folder: routes, images, assets, a single-page app.
- **it should live at your own URL.** Artifacts are served from claude.ai, and a public one shows
  viewers outside your organization the label "Content is user-generated and unverified". gangway
  serves it on your domain, with your theme. See [Domains](/docs/use/domains/).
- **your Claude Code session cannot publish artifacts.** They need a claude.ai login, so sessions on
  an API key, Amazon Bedrock, Google Vertex, Microsoft Foundry or an LLM gateway cannot publish, and
  neither can organizations with Zero Data Retention, HIPAA or customer-managed keys. gangway only
  needs its MCP URL.
- **you use more than one agent.** Codex, Cursor, VS Code and ChatGPT deploy to the same server, and
  the same previews. See [Connect an agent](/docs/use/agents/).
- **the data has to stay with you.** Artifacts are stored on Anthropic's infrastructure; gangway runs
  on your hardware.

## Side by side

|                 | Claude artifacts                                                  | gangway                                                          |
| --------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Where it runs   | claude.ai, from a sandboxed `claudeusercontent.com` origin        | your server, NAS or laptop                                       |
| Made from       | a Claude chat or a Claude Code session signed in to claude.ai     | any MCP client, the dashboard, the REST API, or a pull request   |
| What it can be  | one HTML or Markdown page, up to 16 MiB                           | a static site, an artifact template, or any Docker Compose stack |
| Network         | its own origin, five CDNs and Google Fonts; connectors via Claude | anything the app calls                                           |
| Storage         | up to 20 MB of text per artifact                                  | Postgres, MySQL or Redis beside the app, with a data browser     |
| Who can open it | you, people in your organization, or anyone with the link         | public, unlisted, a password, or people signed in to gangway     |
| Your own domain | no                                                                | yes; see [Domains](/docs/use/domains/)                           |
| Lifetime        | until you delete it, or your organization's retention policy      | a time to live you can extend; idle previews sleep               |
| Cost            | included in Claude plans                                          | free and open source; you bring the server                       |

## Make gangway the default in Claude Code

With both available, Claude Code usually picks its own artifacts for a chart, a diagram or a
document. [Connect an agent](/docs/use/agents/#suggested-for-claude-code) shows how to turn them
off, or to keep them and tell Claude to use gangway instead.

The Claude side of this table is from Anthropic's docs as of October 2026; artifacts change often,
so check there for the current limits.
