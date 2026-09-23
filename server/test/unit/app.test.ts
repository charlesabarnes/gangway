import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createApp, surfaceHandler, type AppDeps } from "../../src/app/app.ts";
import { requirePermission } from "../../src/app/middleware/auth.ts";
import {
  actorId,
  auditActor,
  can,
  permissionsForScopes,
  staticTokenVerifier,
  systemActor,
  tokenActor,
  type Actor,
} from "../../src/auth/actor.ts";
import { ALL_PERMISSIONS, SCOPE_PERMISSIONS } from "@gangway/shared/permissions";
import { conflict, rateLimited } from "../../src/errors.ts";
import { Logger } from "../../src/logger.ts";
import { ULID_RE } from "../../src/util/ulid.ts";

const TOKEN = "gw_test_admin_token_0123456789";
const root = mkdtempSync(join(tmpdir(), "gangway-static-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "index.html"), "<html>shell</html>");
writeFileSync(join(root, "assets/main-ABCDEF123456.js"), "console.log(1)");
writeFileSync(join(root, "favicon.ico"), "ico");
writeFileSync(join(root, "../outside-secret.txt"), "nope");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function make(over: Partial<AppDeps> = {}) {
  const lines: string[] = [];
  const logger = new Logger("debug", {}, (l) => lines.push(l));
  const readOnly = tokenActor("ro", ["read"]);
  const admin = staticTokenVerifier(TOKEN);
  const app = createApp({
    logger,
    verifyToken: (t) => (t === "gw_readonly_token_0123456789" ? readOnly : admin(t)),
    staticDir: root,
    v1: (api) => {
      api.get("/whoami", (c) => {
        const a = c.get("actor");
        return c.json({ id: actorId(a), kind: a.kind, permissions: [...a.permissions].sort() });
      });
      api.post("/mutate", requirePermission("previews.deploy"), (c) => c.json({ ok: true }));
      api.get("/limited", () => {
        throw rateLimited(30);
      });
      api.get("/boom", () => {
        throw new Error("secret internal detail");
      });
      api.get("/conflict", () => {
        throw conflict("already exists", { project: "gw-x" });
      });
      api.get("/zod", () => {
        z.object({ a: z.string() }).parse({});
        return new Response();
      });
      api.get("/http", () => {
        throw new HTTPException(413, { message: "too big" });
      });
    },
    ...over,
  });
  const as = (surface: "app" | "api") => {
    const h = surfaceHandler(app, surface);
    return (path: string, init: RequestInit = {}) =>
      Promise.resolve(
        h(new Request(`https://${surface}.preview.localhost${path}`, init), { clientIp: "::1" }),
      );
  };
  return { api: as("api"), ui: as("app"), lines };
}

const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

describe("app root", () => {
  test("/healthz is unauthenticated and carries a generated request id", async () => {
    const { api } = make({ health: () => ({ routes: 3 }) });
    const res = await api("/healthz", { headers: { "x-request-id": "attacker-chosen" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, routes: 3 });
    expect(res.headers.get("x-request-id")).toMatch(ULID_RE);
  });

  test("while draining, the control plane answers 503 and /healthz reports unready", async () => {
    let draining = false;
    const { api, ui } = make({ draining: () => draining });
    expect((await api("/v1/whoami", auth)).status).toBe(200);
    draining = true;
    const res = await api("/v1/whoami", auth);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect((await ui("/index.html")).status).toBe(503);
    const health = await api("/healthz");
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ok: false, draining: true });
  });

  test("no page of gangway may be framed except the gate", async () => {
    const { ui, api } = make({
      publicV1: (pub) => {
        pub.get("/auth/gate", (c) => c.redirect("https://x.preview.localhost/"));
      },
    });
    for (const res of [
      await ui("/v1/whoami", auth),
      await api("/v1/whoami", auth),
      await ui("/nope"),
    ]) {
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    }
    const gate = await ui("/v1/auth/gate");
    expect(gate.status).toBe(302);
    expect(gate.headers.get("x-frame-options")).toBeNull();
  });

  test("/v1 answers on both surfaces", async () => {
    const { api, ui } = make();
    expect((await api("/v1/whoami", auth)).status).toBe(200);
    expect((await ui("/v1/whoami", auth)).status).toBe(200);
  });

  test("unknown paths are problem+json 404", async () => {
    const { api } = make();
    const res = await api("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 404, title: "not found", instance: "/nope" });
    expect(body["requestId"]).toBe(res.headers.get("x-request-id"));
  });
});

describe("auth", () => {
  test("missing, malformed and wrong credentials are indistinguishable 401s", async () => {
    const { api } = make();
    const bodies: unknown[] = [];
    for (const h of [
      undefined,
      "Basic abc",
      "Bearer",
      "Bearer wrong-token",
      `Bearer ${TOKEN}x`,
      `bearer  `,
    ]) {
      const res = await api("/v1/whoami", h ? { headers: { authorization: h } } : {});
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="gangway"');
      const b = (await res.json()) as Record<string, unknown>;
      delete b["requestId"];
      bodies.push(b);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  test("authentication runs before routing: an unknown /v1 path is 401, not 404", async () => {
    const { api } = make();
    expect((await api("/v1/does-not-exist")).status).toBe(401);
    expect((await api("/v1/does-not-exist", auth)).status).toBe(404);
  });

  test("the static token is the admin actor; the scheme is case-insensitive", async () => {
    const { api } = make();
    const res = await api("/v1/whoami", { headers: { authorization: `bearer ${TOKEN}` } });
    expect(await res.json()).toEqual({
      id: "env:admin",
      kind: "token",
      permissions: [...ALL_PERMISSIONS].sort(),
    });
  });

  test("requirePermission: a read token cannot deploy, admin can", async () => {
    const { api } = make();
    const ro = await api("/v1/mutate", {
      method: "POST",
      headers: { authorization: "Bearer gw_readonly_token_0123456789" },
    });
    expect(ro.status).toBe(403);
    expect(ro.headers.get("content-type")).toBe("application/problem+json");
    expect((await api("/v1/mutate", { method: "POST", ...auth })).status).toBe(200);
  });

  test("a 403 names the permission that was missing", async () => {
    const res = await make().api("/v1/mutate", {
      method: "POST",
      headers: { authorization: "Bearer gw_readonly_token_0123456789" },
    });
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'requires the "previews.deploy" permission',
    );
  });

  test("scopes bundle permissions: admin is all, deploy has read, read cannot mutate", () => {
    const p = (...scopes: Parameters<typeof permissionsForScopes>[0]) =>
      permissionsForScopes(scopes);
    expect([...p("admin")].sort()).toEqual([...ALL_PERMISSIONS].sort());
    for (const r of SCOPE_PERMISSIONS.read) expect(p("deploy").has(r)).toBe(true);
    expect(p("deploy").has("previews.destroy")).toBe(true);
    expect(p("deploy").has("users.manage")).toBe(false);
    expect(p("read").has("previews.deploy")).toBe(false);
    expect(p().size).toBe(0);
  });

  test("actorId: a user can never be mistaken for a token, even with the same raw id", () => {
    const user: Actor = {
      kind: "user",
      userId: "env:admin",
      roleId: "viewer",
      permissions: new Set(),
      sessionId: "s",
    };
    expect(actorId(user)).toBe("user:env:admin");
    expect(actorId(tokenActor("env:admin", ["admin"]))).toBe("env:admin");
    expect(can(user, "previews.read")).toBe(false);
  });

  test("auditActor maps onto the audit table's actor_type", () => {
    expect(auditActor(systemActor("ttl-sweep"))).toEqual({ type: "system", id: "ttl-sweep" });
    expect(auditActor(tokenActor("env:admin", ["admin"]))).toEqual({
      type: "token",
      id: "env:admin",
    });
    expect(
      auditActor({
        kind: "user",
        userId: "u1",
        roleId: "member",
        permissions: new Set(),
        sessionId: "s",
      }),
    ).toEqual({ type: "user", id: "u1" });
  });
});

describe("problem+json", () => {
  test("a thrown error carries its own headers: a 429 says when to come back", async () => {
    const res = await make().api("/v1/limited", auth);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(((await res.json()) as { retryAfter: number }).retryAfter).toBe(30);
  });

  test("AppError keeps its detail members", async () => {
    const res = await make().api("/v1/conflict", auth);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      detail: "already exists",
      project: "gw-x",
      instance: "/v1/conflict",
    });
  });

  test("an unexpected throw is a bare 500 for the client and a full record in the log", async () => {
    const { api, lines } = make();
    const res = await api("/v1/boom", auth);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret internal detail");
    expect(text).not.toContain("at ");
    const logged = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "unhandled request error");
    expect(logged.err.message).toBe("secret internal detail");
    expect(logged.requestId).toBe(res.headers.get("x-request-id"));
  });

  test("zod failures are 422 with issue paths", async () => {
    const res = await make().api("/v1/zod", auth);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ issues: [{ path: "a" }] });
  });

  test("Hono HTTPException maps onto the taxonomy", async () => {
    const res = await make().api("/v1/http", auth);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ title: "payload too large", detail: "too big" });
  });
});

describe("static + SPA fallback", () => {
  test("index at /, and for client-side routes", async () => {
    const { ui } = make();
    for (const p of ["/", "/previews", "/previews/01ABC/logs"]) {
      const res = await ui(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>shell</html>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("hashed assets are immutable, unhashed are not", async () => {
    const { ui } = make();
    const hashed = await ui("/assets/main-ABCDEF123456.js");
    expect(hashed.headers.get("cache-control")).toContain("immutable");
    expect(hashed.headers.get("content-type")).toContain("javascript");
    expect((await ui("/favicon.ico")).headers.get("cache-control")).toBe("no-cache");
  });

  test("a missing asset is a 404, never the shell", async () => {
    const res = await make().ui("/assets/gone-ABCDEF123456.js");
    expect(res.status).toBe(404);
  });

  test("traversal cannot leave the root", async () => {
    const { ui } = make();
    for (const p of [
      "/../outside-secret.txt",
      "/%2e%2e/outside-secret.txt",
      "/assets/..%2f..%2foutside-secret.txt",
      "/%00",
    ]) {
      const res = await ui(p);
      expect(await res.text()).not.toContain("nope");
    }
  });

  test("the api surface never serves the shell, and /v1 never falls back to it", async () => {
    const { api, ui } = make();
    expect((await api("/")).status).toBe(404);
    expect((await ui("/v1/nothing", auth)).status).toBe(404);
    expect((await ui("/v1/nothing", auth)).headers.get("content-type")).toBe(
      "application/problem+json",
    );
  });

  test("HEAD has no body; POST is not static's business", async () => {
    const { ui } = make();
    const head = await ui("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await ui("/", { method: "POST" })).status).toBe(404);
  });

  test("no staticDir: the app surface is API-only", async () => {
    const { ui } = make({ staticDir: undefined });
    expect((await ui("/")).status).toBe(404);
  });
});
