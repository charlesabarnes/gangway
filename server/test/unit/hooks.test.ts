/** The hooks surface: the signature is the authentication, and 202 comes before the work. */
import { describe, expect, test } from "bun:test";
import type { Forge, ForgeEvent } from "../../src/forge/forge.ts";
import { GitHubForge } from "../../src/forge/github/forge.ts";
import { signPayload } from "../../src/forge/github/webhook.ts";
import { Hooks } from "../../src/forge/hooks.ts";
import type { Outcome, PrPreviews } from "../../src/forge/pr-previews.ts";
import { Logger } from "../../src/logger.ts";

const SECRET = "s3cret";
const repository = { name: "web-app", full_name: "acme/web-app", owner: { login: "acme" }, clone_url: "https://github.com/acme/web-app.git", private: false };
const opened = {
  action: "opened", repository, installation: { id: 4242 },
  pull_request: { number: 1, title: "t", head: { sha: "a".repeat(40), ref: "f", repo: { full_name: "acme/web-app" } }, base: { ref: "main" }, user: { login: "dev" } },
};

function make(o: { secret?: string; slow?: boolean; fail?: boolean } = {}) {
  const forge = new GitHubForge({ app: {} as never, webhookSecret: () => o.secret ?? SECRET });
  const handled: ForgeEvent[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const service = {
    async handle(event: ForgeEvent): Promise<Outcome> {
      handled.push(event);
      if (o.slow) await gate;
      if (o.fail) throw new Error("kaboom");
      return { action: "ignored", reason: "fake" };
    },
  } as unknown as PrPreviews;
  const outcomes: [string, Outcome][] = [];
  const hooks = new Hooks({ forge: forge as Forge, service, logger: new Logger("error", {}, () => {}), onOutcome: (id, out) => outcomes.push([id, out]) });
  const handler = hooks.handler();
  const post = (payload: unknown, h: Record<string, string> = {}, o2: { path?: string; method?: string; secret?: string; raw?: string } = {}) => {
    const raw = o2.raw ?? JSON.stringify(payload);
    const headers = new Headers({
      "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "d-1",
      "x-hub-signature-256": signPayload(o2.secret ?? SECRET, new TextEncoder().encode(raw)), ...h,
    });
    return handler(new Request(`https://hooks.preview.localhost:8443${o2.path ?? "/github"}`, { method: o2.method ?? "POST", headers, body: o2.method === "GET" ? null : raw }), { clientIp: "140.82.115.1" });
  };
  return { hooks, post, handled, outcomes, release: () => release() };
}

describe("POST /github", () => {
  test("a signed pull_request delivery is 202 with the event named, and the service is handed the parsed event", async () => {
    const t = make();
    const res = await t.post(opened);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, deliveryId: "d-1", event: "pr.updated" });
    await t.hooks.drain();
    expect(t.handled[0]).toMatchObject({ type: "pr.updated", action: "opened", pr: { number: 1, repo: { fullName: "acme/web-app", installationId: "4242" } } });
    expect(t.outcomes).toEqual([["d-1", { action: "ignored", reason: "fake" }]]);
  });

  test("202 is answered BEFORE the service finishes", async () => {
    const t = make({ slow: true });
    const res = await t.post(opened);
    expect(res.status).toBe(202);
    expect(t.hooks.inflight).toBe(1);
    expect(t.outcomes).toEqual([]);
    t.release();
    await t.hooks.drain();
    expect(t.hooks.inflight).toBe(0);
    expect(t.outcomes).toHaveLength(1);
  });

  test("a bad signature is 401 and the body is never parsed or handled; no secret configured refuses everything", async () => {
    const t = make();
    expect((await t.post(opened, {}, { secret: "wrong" })).status).toBe(401);
    expect((await t.post(opened, { "x-hub-signature-256": "" })).status).toBe(401);
    expect(t.handled).toEqual([]);
    const none = make({ secret: "" });
    expect((await none.post(opened)).status).toBe(401);
  });

  test("the same delivery id twice does the work once", async () => {
    const t = make();
    expect((await t.post(opened)).status).toBe(202);
    const again = await t.post(opened);
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ accepted: false, deliveryId: "d-1", reason: "already delivered" });
    await t.hooks.drain();
    expect(t.handled).toHaveLength(1);
  });

  test("an event we do not act on is 202 with the reason, and nothing runs", async () => {
    const t = make();
    const res = await t.post({ zen: "x" }, { "x-github-event": "ping" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: false, deliveryId: "d-1", reason: "ping" });
    expect(t.handled).toEqual([]);
  });

  test("wrong path 404, wrong method 405, oversized 413, unparsable-but-signed 400", async () => {
    const t = make();
    expect((await t.post(opened, {}, { path: "/gitlab" })).status).toBe(404);
    expect((await t.post(opened, {}, { path: "/" })).status).toBe(404);
    expect((await t.post(opened, {}, { method: "GET" })).status).toBe(405);
    expect((await t.post(opened, { "content-length": String(3 * 1024 * 1024) })).status).toBe(413);
    expect((await t.post(null, {}, { raw: "{not json" })).status).toBe(400);
    expect(t.handled).toEqual([]);
  });

  test("a service that throws is logged as an outcome, not an unhandled rejection", async () => {
    const t = make({ fail: true });
    expect((await t.post(opened)).status).toBe(202);
    await t.hooks.drain();
    expect(t.outcomes[0]![1]).toEqual({ action: "ignored", reason: "failed: kaboom" });
  });
});
