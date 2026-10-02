---
title: gangway and ChatGPT Sites
description: How gangway compares with ChatGPT Sites, and when to pick which.
---

[ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites)
turns what you make in ChatGPT into a website or a small app on OpenAI's hosting. gangway does the
same job on a server you run, for any agent, and for apps that need a real backend.

## Pick ChatGPT Sites when

- you want nothing to install or run, and a paid ChatGPT plan already covers the hosting;
- the site is a front end with light storage: a dashboard, a tracker, a report, a prototype;
- the people who use it are in your ChatGPT workspace, or you want it on your ChatGPT profile.

## Pick gangway when

- **the app needs a real backend.** OpenAI says Sites may not support "some frameworks, private
  networks, databases, background services, and hosting patterns". gangway runs any Docker Compose
  stack: a Node, Bun, Python or PHP server, websockets, workers, and Postgres, MySQL or Redis beside
  it.
- **the data has to stay with you.** Everything runs on your own hardware, on your own network if
  you like, with nothing sent to a third party.
- **you use more than one agent.** Claude Code, Codex, Cursor, VS Code and ChatGPT all deploy through
  the same MCP server. See [Use it from ChatGPT](/docs/use/chatgpt/).
- **you want a preview of every pull request.** A GitHub repository gets one URL per pull request,
  torn down when it closes. See [Pull-request previews](/docs/use/pull-requests/).
- **you want the code to be yours.** What you deploy is your files, and gangway is open source under
  Apache 2.0.

## Side by side

|                 | ChatGPT Sites                                                   | gangway                                                               |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Where it runs   | OpenAI's hosting                                                | your server, NAS or laptop                                            |
| Made from       | a ChatGPT chat                                                  | any MCP client, the dashboard, the REST API, or a pull request        |
| Backend         | light managed storage; some servers and databases not supported | any container: Node, Bun, Python, PHP, websockets, workers            |
| Databases       | managed by Sites                                                | Postgres, MySQL or Redis beside the app, with a data browser          |
| Who can open it | you, chosen people, your workspace, or anyone                   | public, unlisted, a password, or people signed in to gangway          |
| Your own domain | yes, except Enterprise workspaces for now                       | yes, with a certificate per domain; see [Domains](/docs/use/domains/) |
| Lifetime        | until you delete it                                             | a time to live you can extend; idle previews sleep                    |
| Cost            | included in Plus, Pro, Business and Enterprise                  | free and open source; you bring the server                            |

What gangway asks of you: a Docker host and, for anything others can reach, a domain. The
[Quickstart](/docs/quickstart/) takes a few minutes, and
[a laptop install](/docs/install/laptop/) needs no domain at all.

The ChatGPT side of this table is from OpenAI's help pages as of October 2026; Sites changes
often, so check there for the current limits.
