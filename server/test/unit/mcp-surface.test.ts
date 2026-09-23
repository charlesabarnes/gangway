/** The `mcp` surface, driven with real JSON-RPC in both protocol eras. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpSurface } from "../../src/app/mcp-surface.ts";
import { staticTokenVerifier } from "../../src/auth/actor.ts";
import { artifactPrompt, INSTRUCTIONS } from "../../src/mcp/guide.ts";
import { resolvePreview } from "../../src/mcp/resolve.ts";
import { silentLogger } from "../helpers/logger.ts";
import { setupTools } from "../helpers/mcp-tools.ts";

const TOKEN = "gw_mcp_test_token_0123456789abcdefghijk";
const MODERN = "2026-07-28";
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type Message = { id?: number; result?: any; error?: any; method?: string };

function surface() {
  const s = setupTools();
  const mcp = new McpSurface({
    tools: s.tools,
    verifyToken: staticTokenVerifier(TOKEN),
    logger: silentLogger(),
  });
  const h = mcp.handler();
  const call = (
    init: {
      method?: string;
      path?: string;
      body?: unknown;
      headers?: Record<string, string>;
      token?: string | null;
    } = {},
  ) =>
    Promise.resolve(
      h(
        new Request(`https://mcp.preview.localhost:8443${init.path ?? "/"}`, {
          method: init.method ?? "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
            ...init.headers,
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
        { clientIp: "203.0.113.9" },
      ),
    );
  /** The JSON-RPC messages in an SSE body. */
  const messages = async (res: Response) =>
    (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as Message);
  const modern = (id: number, method: string, params: Record<string, unknown> = {}) =>
    call({
      body: {
        jsonrpc: "2.0",
        id,
        method,
        params: { ...params, _meta: { ...ENVELOPE, ...(params["_meta"] as object | undefined) } },
      },
      headers: {
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...(method === "tools/call" || method === "prompts/get"
          ? { "mcp-name": String(params["name"]) }
          : {}),
      },
    });
  const initialize = (clientName: string) =>
    call({
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: clientName, version: "1" },
        },
      },
    });
  return { ...s, mcp, call, messages, modern, initialize };
}

describe("the mcp surface", () => {
  test.each([
    ["no credential", null],
    ["a wrong credential", "gw_wrong"],
  ])("%s is a 401 with a Bearer challenge", async (_what, token) => {
    const s = surface();
    const res = await s.call({
      token,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toStartWith("Bearer");
  });

  test("a browser request is 403; GET and DELETE are 405; other paths 404", async () => {
    const s = surface();
    expect(
      (await s.call({ headers: { origin: "https://evil.preview.localhost:8443" }, body: {} }))
        .status,
    ).toBe(403);
    expect((await s.call({ method: "GET" })).status).toBe(405);
    expect((await s.call({ method: "DELETE" })).status).toBe(405);
    expect((await s.call({ path: "/v1/previews", method: "GET" })).status).toBe(404);
  });

  test("2026-07-28: tools/list names the four tools; tools/call deploys and answers", async () => {
    const s = surface();
    const list = await s.messages(await s.modern(1, "tools/list"));
    expect(
      list
        .at(-1)!
        .result.tools.map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual(["deploy", "destroy", "logs", "status"]);

    const res = await s.modern(2, "tools/call", {
      name: "deploy",
      arguments: { files: { "index.html": "<p>modern</p>" }, name: "modern", visibility: "public" },
      _meta: { progressToken: "p1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const msgs = await s.messages(res);
    expect(msgs.some((m) => m.method === "notifications/progress")).toBe(true);
    const result = msgs.find((m) => m.id === 2)!.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toStartWith("ready: https://modern.preview.localhost:8443/");
    expect(s.mcp.open).toBe(0);
  });

  test("any client gets the instructions on connect and a generate-artifact prompt", async () => {
    const s = surface();
    const init = await s.messages(await s.initialize("codex"));
    expect(init[0]!.result.instructions).toBe(INSTRUCTIONS);
    expect(init[0]!.result.capabilities.prompts).toBeDefined();
    const list = await s.messages(await s.modern(2, "prompts/list"));
    expect(list.at(-1)!.result.prompts.map((p: { name: string }) => p.name)).toEqual([
      "generate-artifact",
    ]);
    const got = await s.messages(
      await s.modern(3, "prompts/get", {
        name: "generate-artifact",
        arguments: { what: "a pomodoro timer" },
      }),
    );
    const text = got.at(-1)!.result.messages[0].content.text as string;
    expect(text).toStartWith("What to build: a pomodoro timer");
    expect(text).toContain('upload: "new"');
    // A prompt is not a tool.
    expect((await s.messages(await s.modern(4, "tools/list"))).at(-1)!.result.tools).toHaveLength(
      4,
    );
  });

  test("the plugin's skill and the server's guide agree on the rules that matter", () => {
    const skill = readFileSync(
      join(import.meta.dir, "../../../plugin/gangway/skills/generate-artifact/SKILL.md"),
      "utf8",
    );
    for (const text of [skill, artifactPrompt(undefined), INSTRUCTIONS]) {
      for (const rule of [
        "bunfig.toml",
        'upload: "new"',
        "check",
        'preview: "<name>"',
        "$PORT",
        'source: "runtime"',
      ]) {
        expect(text.replace(/`/g, "")).toContain(
          rule.replace("$PORT", text === INSTRUCTIONS ? "$PORT" : "PORT"),
        );
      }
    }
    expect(INSTRUCTIONS.length).toBeLessThan(1400);
  });

  test("2025-11-25: initialize, then a call whose refusal is a readable tool error", async () => {
    const s = surface();
    const init = await s.messages(await s.initialize("old"));
    expect(init[0]!.result.serverInfo.name).toBe("gangway");
    const res = await s.messages(
      await s.call({
        headers: { "mcp-protocol-version": "2025-11-25" },
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "status", arguments: { preview: "ghost" } },
        },
      }),
    );
    const result = res.find((m) => m.id === 2)!.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('status refused: no live preview is called "ghost"');
  });

  test("dropAll ends an open stream and the waiting tool gives up", async () => {
    const s = surface();
    s.fake.answering = false;
    const res = await s.modern(3, "tools/call", {
      name: "deploy",
      arguments: {
        image: "traefik/whoami:v1.10",
        port: 80,
        name: "slow",
        visibility: "public",
        waitSeconds: 60,
      },
    });
    expect(s.mcp.open).toBe(1);
    const body = res.body!.getReader();
    const drained = (async () => {
      for (;;) {
        const { done } = await body.read();
        if (done) return;
      }
    })();
    for (let i = 0; i < 200 && s.ctx.previews.list({}).length === 0; i++) await Bun.sleep(5);
    const p = resolvePreview(s.ctx, "slow");
    s.mcp.dropAll();
    expect(s.mcp.open).toBe(0);
    await expect(drained).rejects.toThrow("switched off");
    await s.ctx.inflight.get(p.id)?.done;
  });
});
