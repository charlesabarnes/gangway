import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SCOPE_PERMISSIONS } from "@gangway/shared/permissions";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { tokenRoutes } from "../../src/app/routes/tokens.ts";
import {
  can,
  chainVerifiers,
  confinedToOrg,
  orgBound,
  staticTokenVerifier,
  tokenActor,
  type Actor,
} from "../../src/auth/actor.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { META, PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { silentLogger } from "../helpers/logger.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";

const DAY = 86_400_000;
const ENV = tokenActor("env:admin", ["admin"], HOME_ORG_ID);

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

  test("a scope is refused unless the role covers its whole bundle", async () => {
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

  test("a secrets token keeps its targets, which widen it only within its person's role", async () => {
    const t = await make();
    const bob = await t.person("bob@example.com", "member");
    const own = t.tokens.mint(bob.actor, { name: "agent", scopes: ["deploy", "secrets"] });
    expect(own.token.secretTargets).toEqual({ previews: "own", projects: [], org: false });
    const actor = (await t.tokens.verify(own.secret))!;
    expect(actor).toMatchObject({ secretTargets: { previews: "own" } });
    expect(actor.permissions.has("previews.secrets")).toBe(true);
    expect(actor.permissions.has("repos.secrets")).toBe(false);
    expect(() =>
      t.tokens.mint(bob.actor, {
        name: "wide",
        scopes: ["secrets"],
        secretTargets: { previews: "own", projects: "all", org: false },
      }),
    ).toThrow("your role does not cover project or org secrets");
    const wide = t.tokens.mint(t.adaActor, {
      name: "wide",
      scopes: ["secrets"],
      secretTargets: { previews: "own", projects: ["P1"], org: false },
    });
    expect((await t.tokens.verify(wide.secret))!.permissions.has("repos.secrets")).toBe(true);
  });

  test("a database token can never mint another token", async () => {
    const t = await make();
    const { secret } = t.tokens.mint(t.adaActor, { name: "ci", scopes: ["admin"] });
    const asToken = (await t.tokens.verify(secret))!;
    expect(asToken.permissions.has("tokens.manage_own")).toBe(true);
    expect(() => t.tokens.mint(asToken, { name: "child", scopes: ["read"] })).toThrow(
      /cannot create API tokens/,
    );
  });

  test("the env admin token mints ownerless tokens with any scope", async () => {
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
    for (const expiresIn of ["soon", "", "-1d", "0s"]) {
      expect(() => t.tokens.mint(t.adaActor, { name: "x", scopes: ["read"], expiresIn })).toThrow();
    }
  });
});

describe("the org a credential acts in", () => {
  const OTHER = "01JORG0THER00000000000000A";

  test("a token acts in the org of whoever minted it, and a session in its own org", async () => {
    const t = await make();
    expect(t.adaActor.orgId).toBe(HOME_ORG_ID);
    t.db.run(
      `INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ('${OTHER}', 'other', 'Other', 1, 1)`,
    );
    const home = t.tokens.mint(t.adaActor, { name: "home", scopes: ["read"] });
    const away = t.tokens.mint({ ...t.adaActor, orgId: OTHER }, { name: "away", scopes: ["read"] });
    expect((await t.tokens.verify(home.secret))!.orgId).toBe(HOME_ORG_ID);
    expect((await t.tokens.verify(away.secret))!.orgId).toBe(OTHER);

    const { secret } = await t.accounts.login("ada@example.com", PASSWORD, META);
    t.db.run("UPDATE sessions SET org_id = $o", { o: OTHER });
    expect(t.sessions.resolve(secret)!.actor.orgId).toBe(OTHER);
  });

  test("another org's admin mints an admin token, which never acts on the whole server", async () => {
    const t = await make();
    t.db.run(
      `INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ('${OTHER}', 'other', 'Other', 1, 1)`,
    );
    const theirs = confinedToOrg({ ...t.adaActor, orgId: OTHER }, HOME_ORG_ID);
    expect(can(theirs, "settings.write")).toBe(false);
    const { secret } = t.tokens.mint(theirs, { name: "ci", scopes: ["admin"] });
    const used = (await orgBound(t.tokens.verify, HOME_ORG_ID)(secret))!;
    expect(can(used, "previews.destroy")).toBe(true);
    expect(can(used, "settings.write")).toBe(false);
    expect(can(used, "users.manage")).toBe(false);
  });

  test("the env admin token is the home org's", async () => {
    const verify = staticTokenVerifier("gw_env_admin_token_0123456789abcdef", HOME_ORG_ID);
    expect((await verify("gw_env_admin_token_0123456789abcdef"))!.orgId).toBe(HOME_ORG_ID);
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

  test("refuses a token not shaped like ours, the env token too, without a lookup", async () => {
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
    ]) {
      expect(await t.tokens.verify(junk)).toBeNull();
    }
    expect(reads).toBe(0);
    expect(await t.tokens.verify(`gw_${"A".repeat(43)}`)).toBeNull();
    expect(reads).toBe(1);
  });

  test("demoting the owner shrinks their token on next use, and promoting restores it", async () => {
    const t = await make();
    const bob = await t.person("bob@example.com", "admin");
    const { secret } = t.tokens.mint(bob.actor, { name: "bobs-admin", scopes: ["admin"] });
    expect((await t.tokens.verify(secret))!.permissions.has("users.manage")).toBe(true);

    await t.accounts.updateUser(t.adaActor, bob.id, { roleId: "viewer" });
    const clamped = (await t.tokens.verify(secret))!;
    expect(clamped.permissions.has("users.manage")).toBe(false);
    expect(clamped.permissions.has("previews.deploy")).toBe(false);
    expect(clamped.permissions.has("previews.read")).toBe(true);
    expect(clamped).toMatchObject({ scopes: ["admin"] });

    await t.accounts.updateUser(t.adaActor, bob.id, { roleId: "admin" });
    expect((await t.tokens.verify(secret))!.permissions.has("users.manage")).toBe(true);
  });

  test("tightening a role shrinks every token owned by someone in it", async () => {
    const t = await make();
    const bob = await t.person("bob@example.com", "member");
    const { secret } = t.tokens.mint(bob.actor, { name: "ci", scopes: ["deploy"] });
    expect((await t.tokens.verify(secret))!.permissions.has("previews.destroy_own")).toBe(true);
    t.roles.set("member", ["previews.read", "previews.deploy", "tokens.manage_own"]);
    expect((await t.tokens.verify(secret))!.permissions.has("previews.destroy_own")).toBe(false);
    expect((await t.tokens.verify(secret))!.permissions.has("previews.deploy")).toBe(true);
  });

  test("a token stops working when expired, revoked, or its owner is disabled", async () => {
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

  test("the verifier chain tries a database token, then the env token", async () => {
    const t = await make();
    const { secret, token } = t.tokens.mint(t.adaActor, { name: "ci", scopes: ["read"] });
    const verify = chainVerifiers(
      t.tokens.verify,
      staticTokenVerifier("gw_env_admin_token_0123456789abcdef", HOME_ORG_ID),
    );
    expect(await verify(secret)).toMatchObject({ tokenId: token.id });
    expect(await verify("gw_env_admin_token_0123456789abcdef")).toMatchObject({
      tokenId: "env:admin",
    });
    expect(await verify("gw_nobody")).toBeNull();
  });
});

describe("listing and revoking", () => {
  test("lists your own, `all` needs tokens.manage_all, and another's id is a 404", async () => {
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
    expect(t.tokens.list(bob.actor)[0]!.revokedAt).not.toBeNull();
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
    api.onError(errorHandler(silentLogger()));
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

  test("a viewer is refused with 403, and bad input is a 422", async () => {
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
