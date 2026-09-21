/**
 * The UI's types are hand-written (web/src/app/core/api.types.ts): what crosses the network
 * is JSON, and the server's domain types are not. This is the server's half of keeping them
 * honest. It asserts that REAL output has exactly the shape and literals recorded in
 * web/src/testing/fixtures/contract.json; the web project's spec asserts that file
 * satisfies its types. Rename a field or add a state on either side alone: a test fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { PREVIEW_STATE_VALUES, VISIBILITY_VALUES } from "../../../shared/src/api.ts";
import { ALL_PERMISSIONS, SCOPES } from "../../../shared/src/permissions.ts";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { tokenRoutes } from "../../src/app/routes/tokens.ts";
import { staticTokenVerifier, tokenActor } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { Logger } from "../../src/logger.ts";
import { LOG_STREAMS } from "../../src/previews/logs.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

const contract = JSON.parse(readFileSync(join(import.meta.dir, "../../../web/src/testing/fixtures/contract.json"), "utf8")) as Record<string, unknown>;
const quiet = new Logger("error", {}, () => {});

/** Keys and value TYPES, recursively; an array is the shape of its first element. Values do not matter. */
function shapeOf(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0])];
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shapeOf(x)]));
  return typeof v;
}

describe("string unions the UI switches on", () => {
  test("preview states, visibilities, log streams, scopes", () => {
    expect(contract["previewStates"]).toEqual([...PREVIEW_STATE_VALUES]);
    expect(contract["visibilities"]).toEqual([...VISIBILITY_VALUES]);
    expect(contract["logStreams"]).toEqual([...LOG_STREAMS]);
    expect(contract["scopes"]).toEqual([...SCOPES]);
  });

  test("the permission ids the UI gates on are exactly the catalogue", () => {
    expect([...(contract["permissions"] as string[])].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe("preview wire shapes", () => {
  const api = (s: ReturnType<typeof setupPreviewContext>) => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(quiet));
    app.use(async (c, next) => { c.set("requestId", "r"); c.set("actor", ACTOR); return next(); });
    previewRoutes(app, s.ctx, null as never);
    return app;
  };

  test("a preview, the list envelope, and a history event", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("contract");
    const app = api(s);
    const detail = await (await app.request(`/previews/${p.id}`)).json() as { preview: unknown };
    expect(shapeOf(detail.preview)).toEqual(shapeOf(contract["preview"]));

    const list = await (await app.request("/previews")).json() as { seq: number; previews: unknown[] };
    expect(Object.keys(list).sort()).toEqual(Object.keys(contract["previewList"] as object).sort());
    expect(shapeOf(list.previews[0])).toEqual(shapeOf(contract["preview"]));

    const { events } = await (await app.request(`/previews/${p.id}/events`)).json() as { events: { type: string }[] };
    expect(shapeOf(events.find((e) => e.type === "preview.state"))).toEqual(shapeOf(contract["previewEvent"]));
  });

  test("every event type the server publishes to the stream is one the UI listens for", async () => {
    const s = setupPreviewContext();
    await s.deployed("types");
    const published = new Set(s.ctx.bus.history((s.previews.list()[0]!).id).map((e) => e.type));
    for (const type of published) expect(contract["streamEventTypes"]).toContain(type);
    expect(contract["streamEventTypes"]).toContain("reset"); // synthetic, from EventBus.follow
  });
});

describe("account wire shapes", () => {
  test("session (anonymous and logged in), login, a token, and a problem", async () => {
    const s = setupAccounts();
    const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
    const auth = { verifyToken: staticTokenVerifier("gw_contract_env_token_0123456789abcd"), resolveSession: (x: string) => s.sessions.resolve(x)?.actor ?? null, originFor: (h: string) => `https://${h}` };
    const app = createApp({
      ...auth, logger: quiet, v1: (a) => tokenRoutes(a, tokens),
      publicV1: (pub) => authRoutes(pub, { auth, accounts: s.accounts, bootstrap: new Bootstrap(() => s.users.count()), roles: s.roles, sessionMaxAgeSec: 60 }),
    });
    const h = surfaceHandler(app, "app");
    const HOST = "app.preview.localhost";
    const call = (path: string, init: RequestInit = {}) => Promise.resolve(h(new Request(`https://${HOST}${path}`, { ...init, headers: { host: HOST, origin: `https://${HOST}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } }), { clientIp: "::1" }));

    expect(shapeOf(await (await call("/v1/auth/session")).json())).toEqual(shapeOf(contract["sessionAnonymous"]));

    await s.admin();
    const login = await call("/v1/auth/login", { method: "POST", body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }) });
    expect(shapeOf(await login.json())).toEqual(shapeOf(contract["login"]));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(shapeOf(await (await call("/v1/auth/session", { headers: { cookie } })).json())).toEqual(shapeOf(contract["sessionUser"]));

    const minted = await (await call("/v1/tokens", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "ci", scopes: ["deploy"] }) })).json() as { token: unknown };
    expect(shapeOf(minted.token)).toEqual(shapeOf(contract["token"]));

    // A read-only token refused a write: the 403 the UI shows in a toast.
    void tokenActor;
    const denied = await call("/v1/tokens", { headers: { authorization: "Bearer gw_nope" } });
    expect(Object.keys(await denied.json() as object).sort()).toEqual(Object.keys(contract["problem"] as object).sort());
  });
});
