import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SCOPE_PERMISSIONS } from "@gangway/shared/permissions";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { tokenRoutes } from "../../src/app/routes/tokens.ts";
import {
  chainVerifiers,
  staticTokenVerifier,
  tokenActor,
  type Actor,
} from "../../src/auth/actor.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { Logger } from "../../src/logger.ts";
import { META, PASSWORD, setupAccounts } from "../helpers/accounts.ts";

const DAY = 86_400_000;
const ENV = tokenActor("env:admin", ["admin"]);

async function make() {
  const s = setupAccounts();
  const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
  const { user: ada, secret } = await s.admin();
  const adaActor = s.sessions.resolve(secret)!.actor;
  const person = async (email: string, roleId: string): Promise<{ id: string; actor: Actor }> => {
    const u = await s.accounts.createUser(adaActor, { email, password: PASSWORD, roleId });
    return {
      id: u.id,
      actor: s.sessions.resolve((await s.accounts.login(email, PASSWORD, META)).secret)!.actor,
    };
  };
  return { ...s, tokens, ada, adaActor, person };
}

describe("minting", () => {
  test("the secret is gw_ + 43 chars, is returned once, and is nowhere in the database", async () => {
    const t = await make();
    const { token, secret } = t.tokens.mint(t.adaActor, { name: "ci", scopes: ["deploy"] });
    expect(secret).toMatch(/^gw_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatchObject({
      name: "ci",
      scopes: ["deploy"],
      userId: t.ada.id,
      prefix: secret.slice(0, 11),
      expiresAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(token)).not.toContain(secret);
    expect(JSON.stringify(t.db.query("SELECT * FROM api_tokens"))).not.toContain(secret);
    expect(JSON.stringify(t.auditRepo.page({ limit: 50 }))).not.toContain(secret.slice(11));
  });

  test("a scope is refused unless the role covers its WHOLE bundle", async () => {
    const t = await make();
    const bob = await t.person("bob@example.com", "member");
    expect(
      t.tokens.mint(bob.actor, { name: "ok", scopes: ["read", "deploy"] }).token.scopes,
    ).toEqual(["read", "deploy"]);
    expect(() => t.tokens.mint(bob.actor, { name: "nope", scopes: ["admin"] })).toThrow(
      /does not cover the "admin" scope/,
    );
    try {
      t.tokens.mint(bob.actor, { name: "nope", scopes: ["admin"] });
    } catch (e) {
      expect(e).toMatchObject({ status: 422, detail: { scope: "admin" } });
      expect((e as { detail: { missing: string[] } }).detail.missing).toContain("users.manage");
    }
  });

  test("a database token can never mint: a leaked CI token must not issue itself a successor", async () => {
    const t = await make();
    const { secret } = t.tokens.mint(t.adaActor, { name: "ci", scopes: ["admin"] });
    const asToken = (await t.tokens.verify(secret))!;
    expect(asToken.permissions.has("tokens.manage_own")).toBe(true); // it HAS the permission...
    expect(() => t.tokens.mint(asToken, { name: "child", scopes: ["read"] })).toThrow(
      /cannot create API tokens/,
    ); // ...and still may not
  });

  test("the env admin token mints OWNERLESS tokens, with any scope", async () => {
    const t = await make();
    const { token, secret } = t.tokens.mint(ENV, { name: "bootstrap-ci", scopes: ["admin"] });
    expect(token.userId).toBeNull();
    expect((await t.tokens.verify(secret))!).toMatchObject({
      kind: "token",
      tokenId: token.id,
      scopes: ["admin"],
    });
    expect("userId" in (await t.tokens.verify(secret))!).toBe(false);
  });

  test("expiresIn is a duration; nonsense is a 422", async () => {
    const t = await make();
    expect(
      t.tokens.mint(t.adaActor, { name: "short", scopes: ["read"], expiresIn: "90d" }).token
        .expiresAt,
    ).toEqual(new Date(t.clock.t + 90 * DAY));
    for (const expiresIn of ["soon", "", "-1d", "0s"])
      expect(() => t.tokens.mint(t.adaActor, { name: "x", scopes: ["read"], expiresIn })).toThrow();
  });
});

describe("verifying", () => {
  test("a token does what its scopes say, and the actor knows who owns it", async () => {
    const t = await make();
    const { secret, token } = t.tokens.mint(t.adaActor, { name: "ci", scopes: ["deploy"] });
    const actor = (await t.tokens.verify(secret))!;
    expect(actor).toMatchObject({
      kind: "token",
      tokenId: token.id,
      scopes: ["deploy"],
      userId: t.ada.id,
    });
    expect([...actor.permissions].sort()).toEqual([...SCOPE_PERMISSIONS.deploy].sort());
  });

  test("anything not shaped like ours is refused WITHOUT a database read -- including the env token", async () => {
    const t = await make();
    let reads = 0;
    const { findActiveByHash } = t.tokensRepo;
    t.tokensRepo.findActiveByHash = function (...a) {
      reads++;
      return findActiveByHash.apply(this, a);
    };
    for (const junk of [
      "",
      "gw_short",
      "Bearer x",
      "gw_e2e_admin_token_0123456789abcdef",
      "x".repeat(100_000),
    ])
      expect(await t.tokens.verify(junk)).toBeNull();
    expect(reads).toBe(0);
    expect(await t.tokens.verify(`gw_${"A".repeat(43)}`)).toBeNull(); // right shape, no such token: one read
    expect(reads).toBe(1);
  });

  test("demoting the owner shrinks their token on its next use; promoting them back restores it", async () => {
    const t = await make();
    const bob = await t.person("bob@example.com", "admin");
    const { secret } = t.tokens.mint(bob.actor, { name: "bobs-admin", scopes: ["admin"] });
    expect((await t.tokens.verify(secret))!.permissions.has("users.manage")).toBe(true);

    await t.accounts.updateUser(t.adaActor, bob.id, { roleId: "viewer" });
    const clamped = (await t.tokens.verify(secret))!;
    expect(clamped.permissions.has("users.manage")).toBe(false);
    expect(clamped.permissions.has("previews.deploy")).toBe(false);
    expect(clamped.permissions.has("previews.read")).toBe(true);
    expect(clamped).toMatchObject({ scopes: ["admin"] }); // what it was minted with is still what it says

    await t.accounts.updateUser(t.adaActor, bob.id, { roleId: "admin" });
    expect((await t.tokens.verify(secret))!.permissions.has("users.manage")).toBe(true);
  });

  test("tightening a ROLE shrinks every token owned by someone in it", async () => {
    const t = await make();
    const bob = await t.person("bob@example.com", "member");
    const { secret } = t.tokens.mint(bob.actor, { name: "ci", scopes: ["deploy"] });
    expect((await t.tokens.verify(secret))!.permissions.has("previews.destroy")).toBe(true);
    t.roles.set("member", ["previews.read", "previews.deploy", "tokens.manage_own"]);
    expect((await t.tokens.verify(secret))!.permissions.has("previews.destroy")).toBe(false);
    expect((await t.tokens.verify(secret))!.permissions.has("previews.deploy")).toBe(true);
  });

  test("disabled owner, revoked, expired: all simply stop working", async () => {
    const t = await make();
    const bob = await t.person("bob@example.com", "member");
    const a = t.tokens.mint(bob.actor, { name: "a", scopes: ["read"] });
    const b = t.tokens.mint(bob.actor, { name: "b", scopes: ["read"], expiresIn: "1d" });

    t.clock.t += DAY;
    expect(await t.tokens.verify(b.secret)).toBeNull();
    expect(await t.tokens.verify(a.secret)).not.toBeNull();

    await t.accounts.updateUser(t.adaActor, bob.id, { disabled: true });
    expect(await t.tokens.verify(a.secret)).toBeNull();
    await t.accounts.updateUser(t.adaActor, bob.id, { disabled: false });

    t.tokens.revoke(t.adaActor, a.token.id);
    expect(await t.tokens.verify(a.secret)).toBeNull();
  });

  test("last-used is recorded, at most once a minute", async () => {
    const t = await make();
    const { secret, token } = t.tokens.mint(t.adaActor, { name: "ci", scopes: ["read"] });
    await t.tokens.verify(secret);
    const first = t.tokensRepo.get(token.id)!.lastUsedAt!;
    t.clock.t += 30_000;
    await t.tokens.verify(secret);
    expect(t.tokensRepo.get(token.id)!.lastUsedAt).toEqual(first);
    t.clock.t += 31_000;
    await t.tokens.verify(secret);
    expect(t.tokensRepo.get(token.id)!.lastUsedAt!.getTime()).toBe(first.getTime() + 61_000);
  });

  test("the chain: a database token, then the env token, then nobody", async () => {
    const t = await make();
    const { secret, token } = t.tokens.mint(t.adaActor, { name: "ci", scopes: ["read"] });
    const verify = chainVerifiers(
      t.tokens.verify,
      staticTokenVerifier("gw_env_admin_token_0123456789abcdef"),
    );
    expect(await verify(secret)).toMatchObject({ tokenId: token.id });
    expect(await verify("gw_env_admin_token_0123456789abcdef")).toMatchObject({
      tokenId: "env:admin",
    });
    expect(await verify("gw_nobody")).toBeNull();
  });
});

describe("listing and revoking", () => {
  test("you see your own; `all` needs tokens.manage_all; someone else's id is a 404, not a 403", async () => {
    const t = await make();
    const bob = await t.person("bob@example.com", "member");
    const carol = await t.person("carol@example.com", "member");
    const bobs = t.tokens.mint(bob.actor, { name: "bobs", scopes: ["read"] }).token;
    t.tokens.mint(carol.actor, { name: "carols", scopes: ["read"] });

    expect(t.tokens.list(bob.actor).map((x) => x.name)).toEqual(["bobs"]);
    expect(() => t.tokens.list(bob.actor, { all: true })).toThrow(/tokens.manage_all/);
    expect(
      t.tokens
        .list(t.adaActor, { all: true })
        .map((x) => x.name)
        .sort(),
    ).toEqual(["bobs", "carols"]);
    expect(
      t.tokens
        .list(ENV)
        .map((x) => x.name)
        .sort(),
    ).toEqual(["bobs", "carols"]);

    expect(() => t.tokens.revoke(carol.actor, bobs.id)).toThrow(/no such token/);
    expect(() => t.tokens.revoke(carol.actor, "does-not-exist")).toThrow(/no such token/);
    expect(t.tokens.revoke(bob.actor, bobs.id).revokedAt).not.toBeNull();
    expect(t.tokens.list(bob.actor)[0]!.revokedAt).not.toBeNull(); // still listed: the audit trail needs a name
  });

  test("revoking twice is quiet, and recorded once", async () => {
    const t = await make();
    const { token } = t.tokens.mint(t.adaActor, { name: "ci", scopes: ["read"] });
    t.tokens.revoke(t.adaActor, token.id);
    t.tokens.revoke(t.adaActor, token.id);
    expect(t.actions().filter((a) => a === "token.revoked")).toHaveLength(1);
    expect(t.actions()).toContain("token.created");
  });
});

describe("/v1/tokens", () => {
  const http = (tokens: Tokens, actor: Actor) => {
    const api = new Hono<AppEnv>();
    api.onError(errorHandler(new Logger("error", {}, () => {})));
    api.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", actor);
      return next();
    });
    tokenRoutes(api, tokens);
    return (path: string, init?: RequestInit) => api.request(path, init);
  };
  const post = (body: unknown): RequestInit => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

  test("POST is the only response that ever contains the secret", async () => {
    const t = await make();
    const call = http(t.tokens, t.adaActor);
    const made = await call(
      "/tokens",
      post({ name: " ci ", scopes: ["deploy"], expiresIn: "30d" }),
    );
    expect(made.status).toBe(201);
    expect(made.headers.get("cache-control")).toBe("no-store");
    const { secret, token } = (await made.json()) as {
      secret: string;
      token: { id: string; name: string };
    };
    expect(token.name).toBe("ci");

    const listed = await (await call("/tokens")).text();
    expect(listed).toContain(token.id);
    expect(listed).not.toContain(secret);
    expect(await (await call(`/tokens/${token.id}`, { method: "DELETE" })).text()).not.toContain(
      secret,
    );
  });

  test("a viewer has no tokens.manage_own: 403. Bad input: 422", async () => {
    const t = await make();
    const vic = await t.person("vic@example.com", "viewer");
    expect((await http(t.tokens, vic.actor)("/tokens")).status).toBe(403);
    const call = http(t.tokens, t.adaActor);
    expect((await call("/tokens", post({ name: "x", scopes: [] }))).status).toBe(422);
    expect((await call("/tokens", post({ name: "x", scopes: ["root"] }))).status).toBe(422);
    expect((await call("/tokens", post({ name: "", scopes: ["read"] }))).status).toBe(422);
    expect((await call("/tokens", { method: "POST", body: "nope" })).status).toBe(400);
  });
});
