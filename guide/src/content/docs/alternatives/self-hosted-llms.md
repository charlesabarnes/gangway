---
title: ChatGPT Sites and Claude artifacts for self-hosted LLMs
description: Give any self-hosted LLM or MCP-compatible agent what ChatGPT Sites and Claude artifacts do, publishing pages and apps to a URL, on your own server.
---

ChatGPT has Sites and Claude has artifacts: ask for a report, a deck, a dashboard or a small app,
and get it back at a link you can share. Run your own model, in a self-hosted chat app or an agent
of your own, and there is nothing like it. The model can write the HTML, but there is nowhere to
put it.

gangway is that place. It is a self-hosted server that any MCP-compatible client can deploy to, so
whatever model you run gets the same "make it and give me the link" that ChatGPT and Claude users
have, with everything on your own hardware.

## What your model gets

- **Pages at a URL on your domain.** Documents, slide decks, dashboards and boards from gangway's
  templates, in your own theme, or any static site the model writes.
- **Whole apps, not just pages.** A Node, Bun, Python or PHP server, with Postgres, MySQL or Redis
  beside it. Neither Sites nor artifacts runs those.
- **Edits at the same URL.** Ask for a change and the model redeploys in place.
- **Control over who sees it.** Public, unlisted, a password, or only people signed in to gangway.
- **Nothing sent to a third party.** The model, the client and the pages all run on servers you
  own.

## Set it up

1. Install gangway on the same server or another one: see [Quickstart](/docs/quickstart/). It runs
   on any Docker host, including Unraid.
2. Make an API token in gangway and add gangway to your client as an MCP server.
   [Connect any MCP client](/docs/use/mcp-clients/) has the steps.
3. Use a model with reliable tool calling. gangway's `deploy` tool takes whole files, which small
   models get wrong.

## Compared with the hosted ones

|                 | ChatGPT Sites / Claude artifacts | gangway with a self-hosted LLM                      |
| --------------- | -------------------------------- | --------------------------------------------------- |
| The model       | OpenAI's or Anthropic's          | yours: Ollama, vLLM, llama.cpp, or any API you pick |
| Where it runs   | their servers                    | yours                                               |
| What it can be  | a page or a light app            | a page, a static site, or any Docker Compose stack  |
| Your own domain | Sites only, on some plans        | yes; see [Domains](/docs/use/domains/)              |
| Cost            | part of their plans              | free and open source; you bring the server          |

For a closer look at each, see
[gangway as a ChatGPT Sites alternative](/docs/alternatives/chatgpt-sites/) and
[gangway as a Claude artifacts alternative](/docs/alternatives/claude-artifacts/).
