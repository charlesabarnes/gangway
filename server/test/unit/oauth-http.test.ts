import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { IdempotencyRepo } from "../../src/db/repos/index.ts";
import { Tools } from "../../src/mcp/tools.ts";
import { IdempotentDeploys } from "../../src/previews/idempotent.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { silentLogger } from "../helpers/logger.ts";
import {
  challengeOf,
  CLAUDE,
  CONNECTOR,
  ISSUER,
  MCP_HOST,
  oauthOverHttp,
  RESOURCE,
  verifierFor,
} from "../helpers/oauth.ts";
import { ACTOR } from "../helpers/preview-context.ts";

const PRM = `${RESOURCE}/.well-known/oauth-protected-resource`;

describe("the flow over HTTP, as claude.ai drives it", () => {
  test("discovery, consent and the code exchange end in a working tool call", async () => {
    const h = await oauthOverHttp();
    const denied = await h.call(h.mcpH, MCP_HOST, "/", { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PRM}", scope="read deploy"`,
    );
    const prm = await (
      await h.call(h.mcpH, MCP_HOST, "/.well-known/oauth-protected-resource")
    ).json();
    expect(prm).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["read", "deploy", "update", "artifacts"],
    });
    const as = (await (
      await h.call(h.appH, h.HOST, "/.well-known/oauth-authorization-server")
    ).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
    });

    const verifier = verifierFor();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: CLAUDE,
      redirect_uri: CONNECTOR,
      code_challenge: challengeOf(verifier),
      code_challenge_method: "S256",
      state: "st",
      scope: "read deploy",
      resource: RESOURCE,
    });
    const auth = await h.call(h.appH, h.HOST, `/oauth/authorize?${q}`);
    expect(auth.status).toBe(302);
    const consent = new URL(auth.headers.get("location")!, ISSUER);
    expect(consent.pathname).toBe("/connect");
    const id = consent.searchParams.get("request")!;
    const view = (await (
      await h.call(h.appH, h.HOST, `/v1/oauth/requests/${id}`, { cookie: h.cookie })
    ).json()) as { request: { client: { host: string } } };
    expect(view.request.client.host).toBe("claude.ai");
    const decided = await h.call(h.appH, h.HOST, `/v1/oauth/requests/${id}`, {
      method: "POST",
      cookie: h.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    const back = new URL(((await decided.json()) as { redirect: string }).redirect);
    expect(back.searchParams.get("state")).toBe("st");

    const tok = await h.call(h.appH, h.HOST, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        client_id: CLAUDE,
        redirect_uri: CONNECTOR,
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    });
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    const t = (await tok.json()) as { access_token: string };

    const res = await h.toolCall(t.access_token, "status", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("no previews");
    expect(
      (
        await h.call(h.apiH, "api.preview.localhost:8443", "/v1/oauth/grants", {
          headers: { authorization: `Bearer ${t.access_token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("a read-only grant calling deploy gets a step-up 403 asking for deploy", async () => {
    const h = await oauthOverHttp();
    const t = h.exchange(await h.code(h.ada, ["read"]));
    const res = await h.toolCall(t.access_token, "deploy", { image: "x", port: 80 });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PRM}", error="insufficient_scope", scope="read deploy"`,
    );
    expect((await h.toolCall(t.access_token, "status", {})).status).toBe(200);
  });

  test("a deploy grant rebuilds its own preview; another's needs the update scope", async () => {
    const h = await oauthOverHttp();
    h.p.ctx.sources = new SourceStore(dirname(h.p.ctx.workdirs.root));
    const t = h.exchange(await h.code(h.ada, ["read", "deploy"]));
    expect(
      await (
        await h.toolCall(t.access_token, "deploy", {
          files: { "index.html": "v1" },
          name: "mine",
          visibility: "public",
        })
      ).text(),
    ).toContain("ready:");
    const mine = await h.toolCall(t.access_token, "deploy", {
      preview: "mine",
      files: { "index.html": "v2" },
    });
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain("(rebuilt)");

    const tools = new Tools({
      ctx: h.p.ctx,
      deploys: new IdempotentDeploys(h.p.ctx, new IdempotencyRepo(h.p.db, h.p.ctx.now)),
      logger: silentLogger(),
    });
    await tools.deploy(
      { actor: ACTOR, signal: new AbortController().signal },
      { files: { "index.html": "theirs" }, name: "theirs", visibility: "public" },
    );
    const theirs = await h.toolCall(t.access_token, "deploy", {
      preview: "theirs",
      files: { "index.html": "x" },
    });
    expect(theirs.status).toBe(403);
    expect(theirs.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PRM}", error="insufficient_scope", scope="read deploy update"`,
    );

    const u = h.exchange(await h.code(h.ada, ["read", "deploy", "update"]));
    const ok = await h.toolCall(u.access_token, "deploy", {
      preview: "theirs",
      files: { "index.html": "x" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("(rebuilt)");
  });

  test("the token endpoint answers in RFC 6749 JSON and refuses secrets and JSON", async () => {
    const h = await oauthOverHttp();
    const post = (body: string, type = "application/x-www-form-urlencoded") =>
      h.call(h.appH, h.HOST, "/oauth/token", {
        method: "POST",
        headers: { "content-type": type },
        body,
      });
    let r = await post("grant_type=password");
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "unsupported_grant_type" });
    r = await post("grant_type=refresh_token&refresh_token=gwr_nope&client_id=x");
    expect(await r.json()).toMatchObject({ error: "invalid_grant" });
    r = await post("grant_type=authorization_code&client_secret=s");
    expect(r.status).toBe(401);
    r = await post(JSON.stringify({ grant_type: "refresh_token" }), "application/json");
    expect(await r.json()).toMatchObject({ error: "invalid_request" });
  });

  test("an untrusted redirect gets an error page, never a redirect", async () => {
    const h = await oauthOverHttp();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: CLAUDE,
      redirect_uri: "https://evil.example/cb",
      code_challenge: challengeOf(verifierFor()),
      code_challenge_method: "S256",
    });
    const r = await h.call(h.appH, h.HOST, `/oauth/authorize?${q}`);
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    expect(await r.text()).toContain("did not register that redirect_uri");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });

  test("with MCP off, every OAuth endpoint is a 404", async () => {
    const h = await oauthOverHttp();
    h.setMcp(false);
    expect((await h.call(h.appH, h.HOST, "/.well-known/oauth-authorization-server")).status).toBe(
      404,
    );
    expect((await h.call(h.appH, h.HOST, "/oauth/authorize")).status).toBe(404);
    expect((await h.call(h.appH, h.HOST, "/oauth/token", { method: "POST" })).status).toBe(404);
  });

  test("with the UI off, there is no resource metadata and a 401 says only Bearer", async () => {
    const h = await oauthOverHttp();
    h.setUi(false);
    expect((await h.call(h.mcpH, MCP_HOST, "/.well-known/oauth-protected-resource")).status).toBe(
      404,
    );
    expect(
      (await h.call(h.mcpH, MCP_HOST, "/", { method: "POST", body: "{}" })).headers.get(
        "www-authenticate",
      ),
    ).toBe('Bearer realm="gangway"');
  });

  test("the API host never serves the authorization server", async () => {
    const h = await oauthOverHttp();
    const r = await h.call(
      h.apiH,
      "api.preview.localhost:8443",
      "/.well-known/oauth-authorization-server",
    );
    expect(r.status).toBe(404);
  });

  test("connected agents: listed on the account, revoked from it", async () => {
    const h = await oauthOverHttp();
    const t = h.exchange(await h.code());
    const list = (await (
      await h.call(h.appH, h.HOST, "/v1/oauth/grants", { cookie: h.cookie })
    ).json()) as { grants: { id: string }[] };
    expect(list.grants).toHaveLength(1);
    const del = await h.call(h.appH, h.HOST, `/v1/oauth/grants/${list.grants[0]!.id}`, {
      method: "DELETE",
      cookie: h.cookie,
    });
    expect(del.status).toBe(200);
    expect((await h.toolCall(t.access_token, "status", {})).status).toBe(401);
  });
});
