import { describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { GITHUB_ACTIONS_ISSUER, GitHubOidc } from "../../src/auth/oidc.ts";
import { workflowActor } from "../../src/auth/actor.ts";

const AUD = "https://api.preview.example.com";
const NOW = 1_800_000_000_000;

function keypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: { ...(publicKey.export({ format: "jwk" }) as object), kid, alg: "RS256", use: "sig" },
  };
}

function sign(
  k: { kid: string; privateKey: KeyObject },
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT", kid: k.kid, ...header });
  const body = enc(claims);
  const sig = createSign("RSA-SHA256")
    .update(`${head}.${body}`)
    .sign(k.privateKey)
    .toString("base64url");
  return `${head}.${body}.${sig}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: GITHUB_ACTIONS_ISSUER,
  aud: AUD,
  iat: NOW / 1000 - 5,
  nbf: NOW / 1000 - 5,
  exp: NOW / 1000 + 300,
  repository: "acme/web-app",
  repository_id: "123",
  event_name: "pull_request",
  ref: "refs/pull/7/merge",
  sha: "b".repeat(40),
  run_id: "999",
  actor: "dev",
  ...over,
});

function setup() {
  const a = keypair("k1");
  const served = { keys: [a.jwk] as object[] };
  const fetches: string[] = [];
  let clock = NOW;
  const oidc = new GitHubOidc({
    audience: () => AUD,
    now: () => clock,
    fetch: async (url) => {
      fetches.push(url);
      return new Response(JSON.stringify(served), { status: 200 });
    },
  });
  return {
    a,
    served,
    fetches,
    oidc,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("GitHubOidc", () => {
  test("a genuine token gives the run's claims and the key set is cached", async () => {
    const t = setup();
    const c = await t.oidc.verify(sign(t.a, claims()));
    expect(c).toEqual({
      repository: "acme/web-app",
      repositoryId: "123",
      eventName: "pull_request",
      ref: "refs/pull/7/merge",
      sha: "b".repeat(40),
      runId: "999",
      actor: "dev",
    });
    await t.oidc.verify(sign(t.a, claims()));
    expect(t.fetches).toEqual([`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`]);
  });

  test.each([
    ["another audience", claims({ aud: "https://api.elsewhere.example" })],
    ["another issuer", claims({ iss: "https://evil.example" })],
    ["an expiry in the past", claims({ exp: NOW / 1000 - 120 })],
    ["a not-before in the future", claims({ nbf: NOW / 1000 + 600 })],
    ["a bad repository claim", claims({ repository: "../../etc" })],
  ])("refuses a token with %s", async (_, c) => {
    const t = setup();
    expect(await t.oidc.verify(sign(t.a, c))).toBeNull();
  });

  test("refuses alg none and a signature from another key with the same kid", async () => {
    const t = setup();
    expect(await t.oidc.verify(sign(t.a, claims(), { alg: "none" }))).toBeNull();
    expect(await t.oidc.verify(sign(keypair("k1"), claims()))).toBeNull();
  });

  test("accepts an audience list that includes ours", async () => {
    const t = setup();
    expect(await t.oidc.verify(sign(t.a, claims({ aud: ["x", AUD] })))).not.toBeNull();
  });

  test("a stranger's token or a gangway token never makes us fetch keys", async () => {
    const t = setup();
    expect(await t.oidc.verify("gw_abcdef")).toBeNull();
    expect(
      await t.oidc.verify(sign(t.a, claims({ iss: "https://accounts.google.com" }))),
    ).toBeNull();
    expect(await t.oidc.verify(sign(t.a, claims({ aud: "someone-else" })))).toBeNull();
    expect(t.fetches).toEqual([]);
  });

  test("picks up a rotated key by refetching, at most once a minute", async () => {
    const t = setup();
    await t.oidc.verify(sign(t.a, claims()));
    const b = keypair("k2");
    t.served.keys.push(b.jwk);
    t.advance(30_000);
    expect(await t.oidc.verify(sign(b, claims()))).toBeNull();
    t.advance(31_000);
    expect(await t.oidc.verify(sign(b, claims()))).not.toBeNull();
    expect(t.fetches).toHaveLength(2);
  });

  test("workflowActor takes the PR number from the ref, and a push has none", () => {
    expect(
      workflowActor({
        repository: "acme/web-app",
        runId: "1",
        actor: "dev",
        eventName: "pull_request",
        ref: "refs/pull/7/merge",
      }),
    ).toMatchObject({ kind: "workflow", pull: 7 });
    expect(
      workflowActor({
        repository: "acme/web-app",
        runId: "1",
        actor: "dev",
        eventName: "push",
        ref: "refs/heads/main",
      }),
    ).toMatchObject({ pull: null });
  });
});
