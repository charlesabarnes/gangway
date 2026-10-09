/**
 * The tenancy contract over MCP: every tool, called by one org at another org's things. A tool
 * missing from TOOLS fails here.
 */
import { beforeEach, expect, test } from "bun:test";
import { client } from "../helpers/fake-daemon.ts";
import { tarball } from "../helpers/runtimes-fixtures.ts";
import { bootWorld, leaked, snapshot, type Org, type World } from "../helpers/tenancy-world.ts";

let world: World;

// A fresh world for each test: the cleanup after every test stops the server it booted.
beforeEach(async () => {
  world = await bootWorld();
}, 30_000);

const MCP = "mcp.preview.localhost";
const MODERN = "2026-07-28";

type Answer = {
  result?: { isError?: boolean; content?: { text?: string }[]; tools?: { name: string }[] };
  error?: { message: string };
};

/** One JSON-RPC call as `o`, in the stateless protocol era. */
async function rpc(o: Org, method: string, params: Record<string, unknown> = {}, name?: string) {
  const res = await client(world.running)(MCP, "/", {
    method: "POST",
    headers: {
      authorization: `Bearer ${o.secret}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "contract", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const raw = await res.text();
  const data = raw.startsWith("{")
    ? raw
    : (raw.split("\n").findLast((l) => l.startsWith("data: ")) ?? "data: {}").slice(6);
  return JSON.parse(data) as Answer;
}

/** One tools/call: its text, and whether it failed. */
async function tool(o: Org, name: string, args: Record<string, unknown>) {
  const msg = await rpc(o, "tools/call", { name, arguments: args }, name);
  const text = msg.error?.message ?? msg.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  return { failed: msg.error !== undefined || msg.result?.isError === true, text };
}

type Aim = { args: Record<string, unknown>; refused: boolean };
const each = (v: Org, args: (preview: string) => Record<string, unknown>): Aim[] =>
  v.holds.previews.map((p) => ({ args: args(p), refused: true }));

/** Each tool, as another org would aim it at `v`; `refused` calls must fail. */
const TOOLS: Record<string, (v: Org) => Aim[]> = {
  catalog: () => [{ args: { kind: "document" }, refused: false }],
  status: (v) => [{ args: {}, refused: false }, ...each(v, (preview) => ({ preview }))],
  logs: (v) => each(v, (preview) => ({ preview })),
  destroy: (v) => each(v, (preview) => ({ preview })),
  extend: (v) => each(v, (preview) => ({ preview, by: "1d" })),
  share: (v) => each(v, (preview) => ({ preview })),
  deploy: (v) => each(v, (preview) => ({ preview, files: { "index.html": "<h1>mine</h1>" } })),
  domains: (v) => [
    ...each(v, (preview) => ({ target: { preview } })),
    { args: { target: { project: v.holds.project!.slug } }, refused: true },
    { args: { target: { org: true } }, refused: false },
    { args: { claim: v.holds.domain!.name, target: { org: true } }, refused: true },
  ],
  secrets: (v) => [
    { args: { target: { project: v.holds.project!.slug }, set: { X: "1" } }, refused: true },
    ...each(v, (preview) => ({ target: { preview }, set: { X: "1" } })),
  ],
  project: (v) => [{ args: { repository: v.holds.project!.repository }, refused: true }],
  theme: (v) =>
    v.holds.theme ? [{ args: { id: v.holds.theme, name: "Taken" }, refused: true }] : [],
};

test("every MCP tool says what one org may get from it", async () => {
  const listed = await rpc(world.orgs.aye, "tools/list");
  const names = (listed.result?.tools ?? []).map((t) => t.name);
  expect(names.length).toBeGreaterThan(5);
  expect(names.filter((n) => !(n in TOOLS))).toEqual([]);
});

test("an org's own tools answer it, so a refusal below is about the org", async () => {
  const { bee } = world.orgs;
  const own = await tool(bee, "status", { preview: bee.holds.previews[0] });
  expect(own.failed).toBe(false);
  expect(own.text).toContain(`${bee.slug}app`);
});

test("no org reads or changes another org's things through any MCP tool", async () => {
  const { home, aye, bee } = world.orgs;
  const failures: string[] = [];
  for (const [attacker, victim] of [
    [aye, bee],
    [aye, home],
    [home, bee],
  ] as const) {
    for (const [name, aim] of Object.entries(TOOLS)) {
      for (const { args, refused } of aim(victim)) {
        const before = snapshot(world.dir, victim);
        const { failed, text } = await tool(attacker, name, args);
        const sent = JSON.stringify(args);
        // A request's own words come back in its answer; only what it did not send can leak.
        const found = leaked(text, victim).filter((m) => !sent.includes(m));
        const who = `${attacker.slug} -> ${victim.slug} ${name} ${sent}`;
        if (refused && !failed) {
          failures.push(`${who}: answered ${text.slice(0, 160)}`);
        }
        if (found.length) {
          failures.push(`${who}: carried ${found.join(", ")}`);
        }
        if (snapshot(world.dir, victim) !== before) {
          failures.push(`${who}: changed ${victim.slug}'s things`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
}, 60_000);

test("no org deploys another org's upload", async () => {
  const { aye, bee } = world.orgs;
  const made = await tool(bee, "deploy", { upload: "new" });
  const id = /\/uploads\/([\w-]+)/.exec(made.text)?.[1];
  expect(id).toBeDefined();
  const put = await client(world.running)(MCP, `/uploads/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/gzip" },
    body: await tarball({ "index.html": "<h1>bee</h1>" }),
  });
  expect(put.status).toBeLessThan(300);
  const taken = await tool(aye, "deploy", { upload: id, name: "stolen" });
  expect(taken.failed).toBe(true);
});
