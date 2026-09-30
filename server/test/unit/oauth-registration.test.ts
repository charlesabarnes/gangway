import { describe, expect, test } from "bun:test";
import { OAuthClientsRepo } from "../../src/db/repos/index.ts";
import {
  ClientRegistry,
  parseRegistration,
  RegistrationError,
} from "../../src/oauth/client-registration.ts";
import { setupAccounts } from "../helpers/accounts.ts";
import { challengeOf, ISSUER, oauthOverHttp, RESOURCE, verifierFor } from "../helpers/oauth.ts";

const refused = (body: unknown) => {
  try {
    parseRegistration(body);
  } catch (e) {
    return e instanceof RegistrationError ? `${e.code}: ${e.message}` : String(e);
  }
  return "accepted";
};

describe("what registration accepts", () => {
  test("loopback http, https and app schemes; the name is cleaned", () => {
    expect(
      parseRegistration({
        client_name: "  omp\u202E agent ",
        redirect_uris: [
          "http://localhost:3000/callback",
          "https://example.com/cb",
          "cursor://anysphere.cursor-mcp/oauth/callback",
        ],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).toEqual({
      clientName: "omp agent",
      redirectUris: [
        "http://localhost:3000/callback",
        "https://example.com/cb",
        "cursor://anysphere.cursor-mcp/oauth/callback",
      ],
    });
  });

  test("an unnamed client is called after where it redirects", () => {
    expect(parseRegistration({ redirect_uris: ["http://127.0.0.1:9/cb"] }).clientName).toBe(
      "127.0.0.1",
    );
  });

  test("refuses redirects that could leak a code", () => {
    expect(refused({})).toStartWith("invalid_redirect_uri");
    expect(refused({ redirect_uris: [] })).toStartWith("invalid_redirect_uri");
    expect(refused({ redirect_uris: ["http://evil.example/cb"] })).toContain("plain http");
    expect(refused({ redirect_uris: ["javascript:alert(1)"] })).toContain("refused");
    expect(refused({ redirect_uris: ["https://ok.example/cb#frag"] })).toContain("fragment");
    expect(refused({ redirect_uris: ["/relative"] })).toContain("not an absolute URL");
    expect(refused({ redirect_uris: Array(21).fill("https://a.example/cb") })).toContain("1 to 20");
  });

  test("refuses grant and response types gangway does not serve", () => {
    const base = { redirect_uris: ["http://localhost/cb"] };
    expect(refused({ ...base, grant_types: ["client_credentials"] })).toStartWith(
      "invalid_client_metadata",
    );
    expect(refused({ ...base, response_types: ["token"] })).toStartWith("invalid_client_metadata");
    expect(refused([base])).toStartWith("invalid_client_metadata");
  });
});

describe("the registry", () => {
  test("issues a public gwc_ client and finds it again", async () => {
    const s = setupAccounts();
    const reg = new ClientRegistry(new OAuthClientsRepo(s.db), s.now);
    const out = reg.register({ client_name: "omp", redirect_uris: ["http://localhost:3000/cb"] });
    expect(out.client_id).toMatch(/^gwc_[A-Za-z0-9_-]{32}$/);
    expect(out.token_endpoint_auth_method).toBe("none");
    expect(out).not.toHaveProperty("client_secret");
    expect(reg.get(out.client_id)).toEqual({
      clientId: out.client_id,
      clientName: "omp",
      redirectUris: ["http://localhost:3000/cb"],
      registered: true,
    });
    expect(() => reg.get("gwc_nope")).toThrow("no client is registered");
  });

  test("a registration never used is purged after a day; one that authorized is kept", async () => {
    const s = setupAccounts();
    let now = 1_000_000;
    const reg = new ClientRegistry(new OAuthClientsRepo(s.db), () => now);
    const idle = reg.register({ redirect_uris: ["http://localhost/a"] }).client_id;
    const used = reg.register({ redirect_uris: ["http://localhost/b"] }).client_id;
    reg.get(used);
    now += 86_400_000 + 1;
    expect(reg.purgeUnused()).toBe(1);
    expect(() => reg.get(idle)).toThrow();
    expect(reg.get(used).clientId).toBe(used);
  });
});

describe("over HTTP, as a client without a metadata document drives it", () => {
  test("register, consent as unverified, exchange the code and call a tool", async () => {
    const h = await oauthOverHttp();
    const as = (await (
      await h.call(h.appH, h.HOST, "/.well-known/oauth-authorization-server")
    ).json()) as Record<string, unknown>;
    expect(as["registration_endpoint"]).toBe(`${ISSUER}/oauth/register`);

    const cb = "http://localhost:3000/callback";
    const reg = await h.call(h.appH, h.HOST, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "omp", redirect_uris: [cb] }),
    });
    expect(reg.status).toBe(201);
    expect(reg.headers.get("cache-control")).toBe("no-store");
    const { client_id } = (await reg.json()) as { client_id: string };

    const verifier = verifierFor();
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: cb,
      code_challenge: challengeOf(verifier),
      code_challenge_method: "S256",
      state: "st",
      scope: "read deploy",
      resource: RESOURCE,
    });
    const auth = await h.call(h.appH, h.HOST, `/oauth/authorize?${q}`);
    expect(auth.status).toBe(302);
    const id = new URL(auth.headers.get("location")!, ISSUER).searchParams.get("request")!;
    const view = (await (
      await h.call(h.appH, h.HOST, `/v1/oauth/requests/${id}`, { cookie: h.cookie })
    ).json()) as { request: { client: { name: string; verified: boolean } } };
    expect(view.request.client).toMatchObject({ name: "omp", verified: false });

    const decided = await h.call(h.appH, h.HOST, `/v1/oauth/requests/${id}`, {
      method: "POST",
      cookie: h.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    const back = new URL(((await decided.json()) as { redirect: string }).redirect);
    const tok = await h.call(h.appH, h.HOST, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        client_id,
        redirect_uri: cb,
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    });
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string };
    expect((await h.toolCall(t.access_token, "status", {})).status).toBe(200);
  });

  test("a redirect the client did not register is refused at authorize", async () => {
    const h = await oauthOverHttp();
    const { client_id } = h.registry.register({ redirect_uris: ["http://localhost:3000/cb"] });
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "https://evil.example/cb",
      code_challenge: challengeOf(verifierFor()),
      code_challenge_method: "S256",
    });
    const res = await h.call(h.appH, h.HOST, `/oauth/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("did not register that redirect_uri");
  });

  test("bad bodies get RFC 7591 errors, and registrations are rate-limited", async () => {
    const h = await oauthOverHttp();
    const post = (body: string, type = "application/json") =>
      h.call(h.appH, h.HOST, "/oauth/register", {
        method: "POST",
        headers: { "content-type": type },
        body,
      });
    const notJson = await post("nope");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid_client_metadata" });
    expect(await (await post('{"redirect_uris":["http://x.example/cb"]}')).json()).toMatchObject({
      error: "invalid_redirect_uri",
    });
    expect((await post("{}", "text/plain")).status).toBe(400);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await post('{"redirect_uris":["http://localhost/cb"]}')).status;
    }
    expect(last).toBe(429);
  });
});
