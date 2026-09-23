import { describe, expect, test } from "bun:test";
import { staticTokenVerifier, type Actor } from "../../src/auth/actor.ts";
import { CONNECTOR, ISSUER, setupOAuth } from "../helpers/oauth.ts";

const requestIdOf = (out: unknown) => (out as { requestId: string }).requestId;

describe("authorize: nothing is redirected until the redirect is trusted", () => {
  test.each([
    [{ client_id: null }, "no client"],
    [{ redirect_uri: null }, "no redirect_uri"],
    [{ client_id: "https://unknown.example/c" }, "could not be identified"],
    [{ redirect_uri: "https://evil.example/cb" }, "did not register"],
  ])("%j is an error page", async (over, why) => {
    const s = await setupOAuth();
    const out = await s.oauth.authorize(s.authorizeQuery(over));
    expect(out.kind).toBe("page");
    expect((out as { error: string }).error).toContain(why);
  });

  test.each([
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge: null }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ resource: "https://api.preview.localhost:8443" }, "invalid_target"],
    [{ scope: "read admin" }, "invalid_scope"],
  ])("%j goes back to the client as %s, with state and iss", async (over, error) => {
    const s = await setupOAuth();
    const out = await s.oauth.authorize(s.authorizeQuery(over));
    expect(out.kind).toBe("redirect");
    const u = new URL((out as { url: string }).url);
    expect(`${u.origin}${u.pathname}`).toBe(CONNECTOR);
    expect(u.searchParams.get("error")).toBe(error);
    expect(u.searchParams.get("state")).toBe("xyz");
    expect(u.searchParams.get("iss")).toBe(ISSUER);
  });

  test("a repeated parameter is refused", async () => {
    const s = await setupOAuth();
    const q = s.authorizeQuery();
    q.append("scope", "read");
    expect(
      new URL(((await s.oauth.authorize(q)) as { url: string }).url).searchParams.get("error"),
    ).toBe("invalid_request");
  });

  test("offline_access is accepted and ignored; no scope asks for read and deploy", async () => {
    const s = await setupOAuth();
    const off = await s.oauth.authorize(s.authorizeQuery({ scope: "deploy offline_access" }));
    expect(s.oauth.view(s.ada, requestIdOf(off)).requested).toEqual(["deploy"]);
    const none = await s.oauth.authorize(s.authorizeQuery({ scope: null }));
    expect(s.oauth.view(s.ada, requestIdOf(none)).requested).toEqual(["read", "deploy"]);
  });
});

describe("consent", () => {
  test("the view names the client's host and the redirect's", async () => {
    const s = await setupOAuth();
    const id = requestIdOf(await s.oauth.authorize(s.authorizeQuery()));
    expect(s.oauth.view(s.ada, id)).toMatchObject({
      client: { name: "Claude", host: "claude.ai" },
      redirectHost: "claude.ai",
      requested: ["read", "deploy"],
      grantable: ["read", "deploy"],
    });
  });

  test("deny goes back as access_denied and spends the request", async () => {
    const s = await setupOAuth();
    const id = requestIdOf(await s.oauth.authorize(s.authorizeQuery()));
    const { redirect } = s.oauth.decide(s.ada, id, { approve: false });
    expect(new URL(redirect).searchParams.get("error")).toBe("access_denied");
    expect(() => s.oauth.view(s.ada, id)).toThrow("expired or was already answered");
  });

  test("only a person can consent; not even the env admin token can", async () => {
    const s = await setupOAuth();
    const id = requestIdOf(await s.oauth.authorize(s.authorizeQuery()));
    const env = staticTokenVerifier("gw_env")("gw_env") as Actor;
    expect(() => s.oauth.view(env, id)).toThrow("only a person");
    expect(() => s.oauth.decide(env, id, { approve: true })).toThrow("only a person");
  });

  test("a viewer can grant read but not deploy, as when minting a token", async () => {
    const s = await setupOAuth();
    const viewer = {
      kind: "user",
      userId: s.user.id,
      roleId: "viewer",
      sessionId: "s",
      permissions: s.roles.for("viewer"),
    } as never;
    const id = requestIdOf(await s.oauth.authorize(s.authorizeQuery()));
    expect(s.oauth.view(viewer, id).grantable).toEqual(["read"]);
    expect(() => s.oauth.decide(viewer, id, { approve: true, scopes: ["read", "deploy"] })).toThrow(
      "cannot grant deploy",
    );
    expect(() => s.oauth.decide(viewer, id, { approve: true, scopes: [] })).toThrow(
      "at least one scope",
    );
    const { redirect } = s.oauth.decide(viewer, id, { approve: true, scopes: ["read"] });
    expect(new URL(redirect).searchParams.get("code")).toBeTruthy();
  });

  test("a pending request lives 10 minutes", async () => {
    const s = await setupOAuth();
    const id = requestIdOf(await s.oauth.authorize(s.authorizeQuery()));
    s.clock.t += 10 * 60_000 + 1;
    expect(() => s.oauth.view(s.ada, id)).toThrow("expired");
  });
});
