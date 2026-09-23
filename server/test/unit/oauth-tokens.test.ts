import { describe, expect, test } from "bun:test";
import { ACCESS_TTL_MS, REFRESH_IDLE_MS, REFRESH_REUSE_GRACE_MS } from "../../src/oauth/server.ts";
import { CLAUDE, CONNECTOR, setupOAuth } from "../helpers/oauth.ts";

describe("tokens", () => {
  test("a code becomes tokens that act as the user, clamped to the granted scopes", async () => {
    const s = await setupOAuth();
    const t = s.exchange(await s.code(s.ada, ["read"]));
    expect(t).toMatchObject({
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      scope: "read",
    });
    expect(t.access_token).toMatch(/^gwa_/);
    expect(t.refresh_token).toMatch(/^gwr_/);
    const actor = (await s.oauth.verify(t.access_token))!;
    expect(actor).toMatchObject({ kind: "token", userId: s.user.id, scopes: ["read"] });
    expect(actor.permissions.has("previews.read")).toBe(true);
    expect(actor.permissions.has("previews.deploy")).toBe(false);
    expect(s.actions()).toContain("oauth.grant.created");
    expect(JSON.stringify(s.auditRepo.page({ limit: 50 }))).not.toContain(t.access_token);
  });

  test("a code is single-use, lives 60 s, and a replay revokes what it made", async () => {
    const s = await setupOAuth();
    const c = await s.code();
    const t = s.exchange(c);
    expect(() => s.exchange(c)).toThrow("already used");
    expect(await s.oauth.verify(t.access_token)).toBeNull();
    const late = await s.code();
    s.clock.t += 60_001;
    expect(() => s.exchange(late)).toThrow("unknown or expired");
  });

  test.each([
    [{ code_verifier: "x".repeat(43) }, "does not match"],
    [{ code_verifier: "short" }, "malformed"],
    [{ client_id: "https://other.example/c" }, "another client"],
    [{ redirect_uri: "http://localhost:9/callback" }, "redirect_uri does not match"],
    [{ resource: "https://api.preview.localhost:8443" }, "only for"],
  ])("the exchange refuses %j", async (over, why) => {
    const s = await setupOAuth();
    const c = await s.code();
    expect(() => s.exchange(c, over)).toThrow(why);
  });

  test("refresh rotates both tokens; replaying the old refresh token revokes the grant", async () => {
    const s = await setupOAuth();
    const first = s.exchange(await s.code());
    const second = s.refresh(first.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await s.oauth.verify(first.access_token)).toBeNull();
    expect(await s.oauth.verify(second.access_token)).not.toBeNull();

    s.clock.t += REFRESH_REUSE_GRACE_MS;
    expect(() => s.refresh(first.refresh_token)).toThrow("not valid");
    expect(await s.oauth.verify(second.access_token)).toBeNull();
    expect(() => s.refresh(second.refresh_token)).toThrow("not valid");
    expect(s.actions().filter((a) => a === "oauth.grant.revoked")).toHaveLength(1);
  });

  test("a rotated-away refresh token within the grace window is refused, not revoked", async () => {
    const s = await setupOAuth();
    const first = s.exchange(await s.code());
    const second = s.refresh(first.refresh_token);
    s.clock.t += REFRESH_REUSE_GRACE_MS - 1;
    expect(() => s.refresh(first.refresh_token)).toThrow("not valid");
    expect(await s.oauth.verify(second.access_token)).not.toBeNull();
    expect(s.actions()).not.toContain("oauth.grant.revoked");

    // The winner's rotation opens a new window for its own token only.
    const third = s.refresh(second.refresh_token);
    expect(await s.oauth.verify(third.access_token)).not.toBeNull();
    expect(() => s.refresh(first.refresh_token)).toThrow("not valid");
    expect(await s.oauth.verify(third.access_token)).not.toBeNull();
  });

  test("refresh cannot widen, cannot outlive 30 idle days, and follows the account", async () => {
    const s = await setupOAuth();
    const t = s.exchange(await s.code(s.ada, ["read"]));
    expect(() => s.refresh(t.refresh_token, { scope: "deploy" })).toThrow("cannot widen");
    s.clock.t += REFRESH_IDLE_MS + 1;
    expect(() => s.refresh(t.refresh_token)).toThrow("expired");

    const u = s.exchange(await s.code());
    s.oauth.revokeAllFor(s.user.id);
    expect(await s.oauth.verify(u.access_token)).toBeNull();
    expect(() => s.refresh(u.refresh_token)).toThrow("not valid");
  });

  test("a demoted owner's token shrinks at once; a disabled owner's stops", async () => {
    const s = await setupOAuth();
    const t = s.exchange(await s.code());
    expect((await s.oauth.verify(t.access_token))!.permissions.has("previews.deploy")).toBe(true);
    s.users.update(s.user.id, { roleId: "viewer" });
    const demoted = (await s.oauth.verify(t.access_token))!;
    expect(demoted.permissions.has("previews.deploy")).toBe(false);
    expect(demoted.permissions.has("previews.read")).toBe(true);
    s.users.update(s.user.id, { disabled: true });
    expect(await s.oauth.verify(t.access_token)).toBeNull();
  });

  test("an access token lives an hour", async () => {
    const s = await setupOAuth();
    const t = s.exchange(await s.code());
    s.clock.t += ACCESS_TTL_MS + 1;
    expect(await s.oauth.verify(t.access_token)).toBeNull();
  });

  test("list and revoke: your own; someone else's is a 404", async () => {
    const s = await setupOAuth();
    s.exchange(await s.code());
    const [g] = s.oauth.list(s.ada);
    expect(g).toMatchObject({
      clientId: CLAUDE,
      clientName: "Claude",
      redirectUri: CONNECTOR,
      scopes: ["read", "deploy"],
    });
    const other = {
      ...s.ada,
      userId: "someone-else",
      permissions: new Set(["tokens.manage_own"]),
    } as never;
    expect(() => s.oauth.revoke(other, g!.id)).toThrow("no such connection");
    expect(s.oauth.revoke(s.ada, g!.id).revokedAt).not.toBeNull();
    expect(s.oauth.list(s.ada)).toEqual([]);
  });
});
