import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { parsePreviewCommand } from "../../src/forge/forge.ts";
import { GitHubApp, type FetchLike } from "../../src/forge/github/app.ts";
import { COMMENT_MARKER, GitHubForge } from "../../src/forge/github/forge.ts";
import { parseGitHubEvent, signPayload, verifySignature } from "../../src/forge/github/webhook.ts";
import { Logger } from "../../src/logger.ts";

const silent = () => new Logger("error", {}, () => {});
const enc = (s: string) => new TextEncoder().encode(s);

/* ------------------------------------------------------------------ fixtures: trimmed real deliveries */

const repository = {
  name: "web-app",
  full_name: "acme/web-app",
  private: false,
  fork: false,
  owner: { login: "acme" },
  clone_url: "https://github.com/acme/web-app.git",
};
const pull = (over: Record<string, unknown> = {}) => ({
  number: 123,
  title: "Add the thing",
  draft: false,
  merged: false,
  html_url: "https://github.com/acme/web-app/pull/123",
  user: { login: "dev" },
  head: {
    sha: "0123456789abcdef0123456789abcdef01234567",
    ref: "feature/thing",
    repo: { full_name: "acme/web-app" },
  },
  base: { ref: "main", repo: { full_name: "acme/web-app" } },
  ...over,
});
const prEvent = (action: string, over: Record<string, unknown> = {}) => ({
  action,
  repository,
  installation: { id: 4242 },
  pull_request: pull(over),
});
const commentEvent = (
  body: string,
  association = "COLLABORATOR",
  over: Record<string, unknown> = {},
) => ({
  action: "created",
  repository,
  installation: { id: 4242 },
  issue: {
    number: 123,
    pull_request: { url: "https://api.github.com/repos/acme/web-app/pulls/123" },
  },
  comment: { id: 987, body, user: { login: "maintainer" }, author_association: association },
  ...over,
});

describe("parsing GitHub's webhook", () => {
  test("pull_request opened / synchronize / reopened / ready_for_review are one event", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"] as const) {
      const ev = parseGitHubEvent("pull_request", prEvent(action));
      expect(ev.type).toBe("pr.updated");
      if (ev.type !== "pr.updated") throw new Error();
      expect(ev.action).toBe(action);
      expect(ev.pr).toMatchObject({
        number: 123,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        headRef: "feature/thing",
        baseRef: "main",
        fromFork: false,
        draft: false,
        author: "dev",
        repo: {
          forge: "github",
          fullName: "acme/web-app",
          owner: "acme",
          name: "web-app",
          installationId: "4242",
          cloneUrl: "https://github.com/acme/web-app.git",
        },
      });
    }
  });

  test("closed carries whether it merged", () => {
    expect(parseGitHubEvent("pull_request", prEvent("closed", { merged: true }))).toMatchObject({
      type: "pr.closed",
      merged: true,
    });
    expect(parseGitHubEvent("pull_request", prEvent("closed"))).toMatchObject({
      type: "pr.closed",
      merged: false,
    });
  });

  test("a head in another repository is a fork; a DELETED head repository counts as one too", () => {
    const fork = parseGitHubEvent(
      "pull_request",
      prEvent("opened", {
        head: { sha: "a".repeat(40), ref: "x", repo: { full_name: "stranger/web-app" } },
      }),
    );
    expect(fork).toMatchObject({ type: "pr.updated", pr: { fromFork: true } });
    const gone = parseGitHubEvent(
      "pull_request",
      prEvent("opened", { head: { sha: "a".repeat(40), ref: "x", repo: null } }),
    );
    expect(gone).toMatchObject({ type: "pr.updated", pr: { fromFork: true } });
  });

  test("actions we do not act on, other events, and pings are `ignored` with a reason -- never a throw", () => {
    expect(parseGitHubEvent("pull_request", prEvent("labeled"))).toEqual({
      type: "ignored",
      reason: "pull_request.labeled",
    });
    expect(parseGitHubEvent("ping", { zen: "Keep it logically awesome." })).toEqual({
      type: "ignored",
      reason: "ping",
    });
    expect(parseGitHubEvent("push", {})).toEqual({ type: "ignored", reason: "event push" });
    expect(parseGitHubEvent(null, null)).toEqual({ type: "ignored", reason: "event (none)" });
    expect(parseGitHubEvent("pull_request", { action: "opened" })).toMatchObject({
      type: "ignored",
    });
    expect(
      parseGitHubEvent("pull_request", { action: "opened", repository, pull_request: pull() }),
    ).toEqual({ type: "ignored", reason: "pull_request without an installation" });
  });

  test("/preview <verb> as the first line of a PR comment is a command, with who said it", () => {
    const ev = parseGitHubEvent("issue_comment", commentEvent("/preview deploy\n\nplease"));
    expect(ev).toEqual({
      type: "pr.command",
      command: "deploy",
      number: 123,
      commentId: 987,
      author: "maintainer",
      association: "collaborator",
      repo: {
        forge: "github",
        fullName: "acme/web-app",
        owner: "acme",
        name: "web-app",
        installationId: "4242",
        cloneUrl: "https://github.com/acme/web-app.git",
        private: false,
      },
    });
    expect(
      parseGitHubEvent("issue_comment", commentEvent("/preview status", "OWNER")),
    ).toMatchObject({ association: "owner" });
    expect(
      parseGitHubEvent("issue_comment", commentEvent("/preview status", "MEMBER")),
    ).toMatchObject({ association: "member" });
    // Having contributed is not authority over the Docker host.
    expect(
      parseGitHubEvent("issue_comment", commentEvent("/preview status", "CONTRIBUTOR")),
    ).toMatchObject({ association: "other" });
    expect(
      parseGitHubEvent("issue_comment", commentEvent("/preview status", "NONE")),
    ).toMatchObject({ association: "other" });
  });

  test("a comment on an issue, an edited comment, or prose mentioning /preview is not a command", () => {
    expect(
      parseGitHubEvent(
        "issue_comment",
        commentEvent("/preview deploy", "OWNER", { issue: { number: 5 } }),
      ),
    ).toMatchObject({ type: "ignored", reason: "a comment on an issue, not a pull request" });
    expect(
      parseGitHubEvent(
        "issue_comment",
        commentEvent("/preview deploy", "OWNER", { action: "edited" }),
      ),
    ).toMatchObject({ type: "ignored" });
    expect(
      parseGitHubEvent("issue_comment", commentEvent("you can run /preview deploy to see it")),
    ).toEqual({ type: "ignored", reason: "not a /preview command" });
  });
});

describe("parsePreviewCommand", () => {
  test.each([
    ["/preview deploy", { command: "deploy" }],
    ["/PREVIEW Redeploy", { command: "redeploy" }],
    ["  /preview destroy  \nmore", { command: "destroy" }],
    ["/preview status", { command: "status" }],
    ["/preview secrets high", { command: "secrets", level: "high" }],
    ["/preview secrets NONE", { command: "secrets", level: "none" }],
    ["/preview secrets", null],
    ["/preview secrets top", null],
    ["/preview", null],
    ["/preview launch", null],
    ["hello\n/preview deploy", null],
    ["/preview deploy now", null],
  ])("%j -> %j", (body, want) => expect(parsePreviewCommand(body)).toEqual(want as never));
});

describe("the signature", () => {
  const secret = "s3cret";
  const body = enc(JSON.stringify({ action: "opened" }));

  test("round-trips, and the verify is over the RAW bytes", () => {
    const sig = signPayload(secret, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(secret, body, sig)).toBe(true);
    expect(verifySignature(secret, enc(JSON.stringify({ action: "opened" }, null, 2)), sig)).toBe(
      false,
    );
  });

  test("wrong secret, missing header, wrong shape, wrong length: all plain false", () => {
    const sig = signPayload(secret, body);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature(secret, body, null)).toBe(false);
    expect(verifySignature(secret, body, "sha1=abc")).toBe(false);
    expect(verifySignature(secret, body, "sha256=abc")).toBe(false);
    expect(verifySignature("", body, signPayload("", body))).toBe(false);
  });
});

/* ------------------------------------------------------------------ the App, against a fake GitHub */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const BASE = "https://api.github.test";

type Call = { method: string; path: string; auth: string | null; body: any };
function fakeGitHub(o: { tokenTtlMs?: number; failEdit?: boolean } = {}) {
  const calls: Call[] = [];
  const comments = new Map<number, string>();
  const revoked = new Set<string>();
  let nextId = 100;
  let tokenSeq = 0;
  let now = 1_700_000_000_000;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl: FetchLike = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.slice(BASE.length);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, auth: headers.get("authorization"), body });

    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      if (!headers.get("authorization")?.startsWith("Bearer "))
        return json(401, { message: "Bad credentials" });
      tokenSeq += 1;
      return json(201, {
        token: `ghs_${tokenSeq}`,
        expires_at: new Date(now + (o.tokenTtlMs ?? 3_600_000)).toISOString(),
      });
    }
    const presented = headers.get("authorization") ?? "";
    if (!presented.startsWith("token ghs_") || revoked.has(presented.slice("token ".length)))
      return json(401, { message: "Bad credentials" });

    if (method === "GET" && path === "/repos/acme/web-app/pulls/123") return json(200, pull());
    if (method === "GET" && path === "/repos/acme/web-app/pulls/999")
      return json(404, { message: "Not Found" });
    if (method === "POST" && path === "/repos/acme/web-app/issues/123/comments") {
      const id = nextId++;
      comments.set(id, body.body);
      return json(201, { id });
    }
    const edit = /^\/repos\/acme\/web-app\/issues\/comments\/(\d+)$/.exec(path);
    if (method === "PATCH" && edit) {
      const id = Number(edit[1]);
      if (o.failEdit || !comments.has(id)) return json(404, { message: "Not Found" });
      comments.set(id, body.body);
      return json(200, { id });
    }
    if (method === "POST" && path === "/repos/acme/web-app/deployments")
      return json(201, { id: 555 });
    if (method === "POST" && path === "/repos/acme/web-app/deployments/555/statuses")
      return json(201, { id: 777 });
    return json(404, { message: `unhandled ${method} ${path}` });
  };

  return {
    fetchImpl,
    calls,
    comments,
    revoke: (t: string) => revoked.add(t),
    clock: {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    },
  };
}

function appAndForge(o: Parameters<typeof fakeGitHub>[0] = {}) {
  const gh = fakeGitHub(o);
  const app = new GitHubApp({
    credentials: () => ({ appId: "12345", privateKey: PEM }),
    fetch: gh.fetchImpl,
    baseUrl: BASE,
    log: silent(),
    now: gh.clock.now,
  });
  const forge = new GitHubForge({ app, webhookSecret: () => "s3cret" });
  const repo = {
    forge: "github" as const,
    fullName: "acme/web-app",
    owner: "acme",
    name: "web-app",
    cloneUrl: "https://github.com/acme/web-app.git",
    installationId: "4242",
    private: false,
  };
  return { gh, app, forge, repo };
}

describe("GitHubApp", () => {
  test("the JWT is RS256 over {iat, exp, iss} and verifies with the public key", () => {
    const { app, gh } = appAndForge();
    const [h, c, s] = app.jwt().split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    const nowS = Math.floor(gh.clock.now() / 1000);
    expect(claims).toEqual({ iat: nowS - 60, exp: nowS - 60 + 600, iss: "12345" });
    expect(
      createVerify("RSA-SHA256")
        .update(`${h}.${c}`)
        .verify(publicKey, Buffer.from(s!, "base64url")),
    ).toBe(true);
  });

  test("an unconfigured App is a clear 422, not a crypto error", () => {
    const app = new GitHubApp({
      credentials: () => ({ appId: "", privateKey: "" }),
      fetch: async () => new Response(""),
      log: silent(),
    });
    expect(() => app.jwt()).toThrow(/not configured/);
  });

  test("installation tokens are minted with the JWT, cached, and re-minted a minute before expiry", async () => {
    const { app, gh } = appAndForge({ tokenTtlMs: 3_600_000 });
    expect(await app.installationToken("4242")).toBe("ghs_1");
    expect(await app.installationToken("4242")).toBe("ghs_1");
    expect(gh.calls.filter((c) => c.path.endsWith("/access_tokens"))).toHaveLength(1);
    expect(gh.calls[0]!.auth).toMatch(/^Bearer /);
    gh.clock.advance(3_600_000 - 61_000);
    expect(await app.installationToken("4242")).toBe("ghs_1");
    gh.clock.advance(2_000);
    expect(await app.installationToken("4242")).toBe("ghs_2");
    // Another installation is another token.
    expect(await app.installationToken("9")).toBe("ghs_3");
  });

  test("concurrent first calls mint ONCE", async () => {
    const { app, gh } = appAndForge();
    const tokens = await Promise.all([
      app.installationToken("4242"),
      app.installationToken("4242"),
      app.installationToken("4242"),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(gh.calls).toHaveLength(1);
  });

  test("a 401 on an installation call forgets the cached token, so the next call mints a fresh one", async () => {
    const { app, gh } = appAndForge();
    expect((await app.asInstallation("4242", "GET", "/repos/acme/web-app/pulls/123")).status).toBe(
      200,
    );
    gh.revoke("ghs_1");
    expect((await app.asInstallation("4242", "GET", "/repos/acme/web-app/pulls/123")).status).toBe(
      401,
    );
    const r = await app.asInstallation("4242", "GET", "/repos/acme/web-app/pulls/123");
    expect(r.status).toBe(200);
    expect(gh.calls.at(-1)!.auth).toBe("token ghs_2");
  });
});

describe("GitHubForge", () => {
  test("verify: signature over the raw body, and the delivery id comes back", () => {
    const { forge } = appAndForge();
    const raw = enc('{"action":"opened"}');
    const headers = new Headers({
      "x-hub-signature-256": signPayload("s3cret", raw),
      "x-github-delivery": "d-1",
      "x-github-event": "pull_request",
    });
    expect(forge.verify(headers, raw)).toEqual({ ok: true, deliveryId: "d-1" });
    headers.set("x-hub-signature-256", signPayload("wrong", raw));
    expect(forge.verify(headers, raw)).toEqual({ ok: false, reason: "bad signature" });
    headers.set("x-hub-signature-256", signPayload("s3cret", raw));
    headers.delete("x-github-delivery");
    expect(forge.verify(headers, raw)).toEqual({ ok: false, reason: "no delivery id" });
  });

  test("verify refuses everything while no secret is configured", () => {
    const { app } = appAndForge();
    const forge = new GitHubForge({ app, webhookSecret: () => "" });
    const raw = enc("{}");
    expect(
      forge.verify(
        new Headers({ "x-hub-signature-256": signPayload("", raw), "x-github-delivery": "d" }),
        raw,
      ),
    ).toEqual({ ok: false, reason: "no webhook secret is configured" });
  });

  test("pullRequest fetches as the installation; 404 is notFound", async () => {
    const { forge, repo, gh } = appAndForge();
    const pr = await forge.pullRequest(repo, 123);
    expect(pr).toMatchObject({
      number: 123,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      fromFork: false,
    });
    expect(gh.calls.at(-1)).toMatchObject({
      method: "GET",
      path: "/repos/acme/web-app/pulls/123",
      auth: "token ghs_1",
    });
    await expect(forge.pullRequest(repo, 999)).rejects.toMatchObject({ code: "not_found" });
  });

  test("cloneCredential is the installation token itself", async () => {
    const { forge, repo } = appAndForge();
    expect(await forge.cloneCredential(repo)).toBe("ghs_1");
  });

  test("upsertComment: creates with the marker, edits in place, and re-creates when the comment was deleted", async () => {
    const { forge, repo, gh } = appAndForge();
    const pr = { repo, number: 123 };
    const id = await forge.upsertComment(pr, null, "building…");
    expect(gh.comments.get(id)).toBe(`${COMMENT_MARKER}\nbuilding…`);
    expect(await forge.upsertComment(pr, id, "ready: https://x")).toBe(id);
    expect(gh.comments.get(id)).toBe(`${COMMENT_MARKER}\nready: https://x`);
    expect(gh.comments.size).toBe(1);
    // Someone deleted it on GitHub.
    gh.comments.delete(id);
    const again = await forge.upsertComment(pr, id, "still here");
    expect(again).not.toBe(id);
    expect(gh.comments.get(again)).toContain("still here");
  });

  test("deployments: created against the head sha as a transient environment, then given a status", async () => {
    const { forge, repo, gh } = appAndForge();
    const id = await forge.createDeployment({ repo, headSha: "abc" }, "preview/web-app-pr-123");
    expect(id).toBe(555);
    expect(gh.calls.at(-1)!.body).toMatchObject({
      ref: "abc",
      environment: "preview/web-app-pr-123",
      transient_environment: true,
      production_environment: false,
      auto_merge: false,
      required_contexts: [],
    });
    await forge.setDeploymentStatus(repo, 555, "success", {
      environmentUrl: "https://web-app-pr-123.preview.example.com/",
    });
    expect(gh.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/repos/acme/web-app/deployments/555/statuses",
      body: {
        state: "success",
        environment_url: "https://web-app-pr-123.preview.example.com/",
        auto_inactive: false,
      },
    });
  });
});

describe("GitHubApp.installedRepositories (ADR-0014)", () => {
  test("every repository across installations, sorted, each with its installation", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: string[] = [];
    const app = new GitHubApp({
      credentials: () => ({
        appId: "1",
        privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      }),
      baseUrl: "https://api.github.test",
      log: new Logger("error", {}, () => {}),
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.github.test", "")}`);
        if (url.endsWith("/app/installations?per_page=100"))
          return Response.json([{ id: 11 }, { id: 22 }]);
        const tok = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
        if (tok)
          return Response.json(
            { token: `ghs_${tok[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 },
          );
        if (url.endsWith("/installation/repositories?per_page=100")) {
          const auth = new Headers(init?.headers).get("authorization");
          return Response.json({
            repositories:
              auth === "token ghs_11"
                ? [{ full_name: "acme/web", private: true }]
                : [{ full_name: "acme/api", private: false }],
          });
        }
        return new Response("{}", { status: 404 });
      },
    });
    expect(await app.installedRepositories()).toEqual([
      { fullName: "acme/api", installationId: "22", private: false },
      { fullName: "acme/web", installationId: "11", private: true },
    ]);
    expect(calls[0]).toBe("GET /app/installations?per_page=100");
  });
});
