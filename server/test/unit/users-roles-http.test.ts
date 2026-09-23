/**
 * /v1/users and /v1/roles through the real app: authenticate, permissions, sessions and
 * tokens are all live, because the point of these routes is what they do to OTHER
 * people's already-open sessions.
 */
import { describe, expect, test } from "bun:test";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from "../../../shared/src/permissions.ts";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { requirePermission } from "../../src/app/middleware/auth.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { roleRoutes } from "../../src/app/routes/roles.ts";
import { tokenRoutes } from "../../src/app/routes/tokens.ts";
import { userRoutes } from "../../src/app/routes/users.ts";
import { chainVerifiers, staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { Logger } from "../../src/logger.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";

const ENV_TOKEN = "gw_users_roles_env_token_0123456789";
const HOST = "app.preview.localhost:8443";
const ORIGIN = `https://${HOST}`;

async function make() {
  const s = setupAccounts();
  const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
  const auth = {
    verifyToken: chainVerifiers(tokens.verify, staticTokenVerifier(ENV_TOKEN)),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  const app = createApp({
    ...auth,
    logger: new Logger("error", {}, () => {}),
    v1: (api) => {
      userRoutes(api, s.accounts);
      roleRoutes(api, s.roles);
      tokenRoutes(api, tokens);
      api.delete("/previews/:id", requirePermission("previews.destroy"), (c) =>
        c.json({ destroyed: c.req.param("id") }),
      );
    },
    publicV1: (pub) =>
      authRoutes(pub, {
        auth,
        accounts: s.accounts,
        bootstrap: new Bootstrap(() => s.users.count()),
        roles: s.roles,
        sessionMaxAgeSec: 60,
      }),
  });
  const handle = surfaceHandler(app, "app");
  const call = (path: string, init: RequestInit & { json?: unknown; as?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", HOST);
    headers.set("origin", ORIGIN);
    if (init.as?.startsWith("gw_")) headers.set("authorization", `Bearer ${init.as}`);
    else if (init.as) headers.set("cookie", init.as);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return Promise.resolve(
      handle(
        new Request(`https://${HOST}${path}`, {
          ...init,
          headers,
          ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        }),
        { clientIp: "203.0.113.7" },
      ),
    );
  };
  const login = async (email: string, password = PASSWORD) =>
    (await call("/v1/auth/login", { method: "POST", json: { email, password } })).headers
      .get("set-cookie")!
      .split(";")[0]!;

  await s.admin();
  const ada = await login("ada@example.com");
  const addUser = async (email: string, roleId: string) =>
    (
      (await (
        await call("/v1/users", {
          method: "POST",
          as: ada,
          json: { email, password: PASSWORD, roleId },
        })
      ).json()) as { user: { id: string } }
    ).user;
  return { s, call, login, ada, addUser };
}

describe("/v1/users", () => {
  test("an admin creates, lists, re-roles and disables; no response ever carries password material", async () => {
    const t = await make();
    const made = await t.call("/v1/users", {
      method: "POST",
      as: t.ada,
      json: { email: "Bob@Example.com", password: PASSWORD, roleId: "member" },
    });
    expect(made.status).toBe(201);
    const { user } = (await made.json()) as {
      user: { id: string; email: string; roleId: string; disabled: boolean };
    };
    expect(user).toMatchObject({ email: "bob@example.com", roleId: "member", disabled: false });

    const listed = await (await t.call("/v1/users", { as: t.ada })).text();
    expect(listed).toContain("bob@example.com");
    for (const leak of ["scrypt", "password", "salt", "hash"])
      expect(listed.toLowerCase()).not.toContain(leak);

    expect(
      await (
        await t.call(`/v1/users/${user.id}`, {
          method: "PATCH",
          as: t.ada,
          json: { roleId: "viewer", disabled: true },
        })
      ).json(),
    ).toMatchObject({ user: { roleId: "viewer", disabled: true } });
  });

  test("members and viewers may not read or manage accounts", async () => {
    const t = await make();
    await t.addUser("bob@example.com", "member");
    const bob = await t.login("bob@example.com");
    expect((await t.call("/v1/users", { as: bob })).status).toBe(403);
    expect(
      (
        await t.call("/v1/users", {
          method: "POST",
          as: bob,
          json: { email: "x@example.com", password: PASSWORD, roleId: "admin" },
        })
      ).status,
    ).toBe(403);
  });

  test("validation: unknown role 422, duplicate email 409, empty patch 422, unknown user 404, extra fields 422", async () => {
    const t = await make();
    const bob = await t.addUser("bob@example.com", "member");
    const post = (json: unknown) => t.call("/v1/users", { method: "POST", as: t.ada, json });
    expect(
      (await post({ email: "c@example.com", password: PASSWORD, roleId: "wizard" })).status,
    ).toBe(422);
    expect(
      (await post({ email: "bob@example.com", password: PASSWORD, roleId: "member" })).status,
    ).toBe(409);
    expect(
      (await post({ email: "c@example.com", password: "short", roleId: "member" })).status,
    ).toBe(422);
    expect(
      (await post({ email: "c@example.com", password: PASSWORD, roleId: "member", admin: true }))
        .status,
    ).toBe(422);
    expect(
      (await t.call(`/v1/users/${bob.id}`, { method: "PATCH", as: t.ada, json: {} })).status,
    ).toBe(422);
    expect(
      (await t.call("/v1/users/nobody", { method: "PATCH", as: t.ada, json: { disabled: true } }))
        .status,
    ).toBe(404);
  });

  test("the last enabled admin cannot lock the door behind them: 409", async () => {
    const t = await make();
    const me = (
      (await (await t.call("/v1/users", { as: t.ada })).json()) as { users: { id: string }[] }
    ).users[0]!;
    expect(
      (
        await t.call(`/v1/users/${me.id}`, {
          method: "PATCH",
          as: t.ada,
          json: { roleId: "viewer" },
        })
      ).status,
    ).toBe(409);
    expect(
      (await t.call(`/v1/users/${me.id}`, { method: "PATCH", as: t.ada, json: { disabled: true } }))
        .status,
    ).toBe(409);
  });

  test("a password reset logs the target out everywhere", async () => {
    const t = await make();
    const bob = await t.addUser("bob@example.com", "member");
    const session = await t.login("bob@example.com");
    expect((await t.call("/v1/tokens", { as: session })).status).toBe(200);
    expect(
      (
        await t.call(`/v1/users/${bob.id}`, {
          method: "PATCH",
          as: t.ada,
          json: { password: "an entirely new password" },
        })
      ).status,
    ).toBe(200);
    expect((await t.call("/v1/tokens", { as: session })).status).toBe(401);
    expect(
      (
        await t.call("/v1/tokens", {
          as: await t.login("bob@example.com", "an entirely new password"),
        })
      ).status,
    ).toBe(200);
  });
});

describe("/v1/roles", () => {
  type RolesBody = {
    roles: { id: string; builtin: boolean; editable: boolean; permissions: string[] }[];
    catalogue: { id: string; feature: string }[];
  };

  test("GET shows the three seeded roles, what each grants, and everything that CAN be granted", async () => {
    const t = await make();
    const body = (await (await t.call("/v1/roles", { as: t.ada })).json()) as RolesBody;
    expect(body.roles.map((r) => [r.id, r.builtin, r.editable])).toEqual([
      ["admin", true, false],
      ["member", true, true],
      ["viewer", true, true],
    ]);
    expect(body.roles[0]!.permissions).toEqual([...ALL_PERMISSIONS].sort());
    expect(body.roles[2]!.permissions).toEqual([...DEFAULT_ROLE_PERMISSIONS.viewer].sort());
    expect(body.catalogue.map((p) => p.id).sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(body.catalogue.map((p) => p.feature)).size).toBeGreaterThan(8);
  });

  test("an edit reaches a member's OPEN session and their TOKEN on the very next request -- no re-login", async () => {
    const t = await make();
    await t.addUser("bob@example.com", "member");
    const session = await t.login("bob@example.com");
    const { secret } = (await (
      await t.call("/v1/tokens", {
        method: "POST",
        as: session,
        json: { name: "ci", scopes: ["deploy"] },
      })
    ).json()) as { secret: string };
    expect((await t.call("/v1/previews/p1", { method: "DELETE", as: session })).status).toBe(200);
    expect((await t.call("/v1/previews/p1", { method: "DELETE", as: secret })).status).toBe(200);

    const without = DEFAULT_ROLE_PERMISSIONS.member.filter((p) => p !== "previews.destroy");
    const put = await t.call("/v1/roles/member/permissions", {
      method: "PUT",
      as: t.ada,
      json: { permissions: without },
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { role: { permissions: string[] } }).role.permissions).toEqual(
      [...without].sort(),
    );

    expect((await t.call("/v1/previews/p1", { method: "DELETE", as: session })).status).toBe(403);
    expect((await t.call("/v1/previews/p1", { method: "DELETE", as: secret })).status).toBe(403);
    // ...and the UI learns of it the same way, from the session endpoint.
    expect(
      (
        (await (await t.call("/v1/auth/session", { as: session })).json()) as {
          permissions: string[];
        }
      ).permissions,
    ).not.toContain("previews.destroy");

    await t.call("/v1/roles/member/permissions", {
      method: "PUT",
      as: t.ada,
      json: { permissions: DEFAULT_ROLE_PERMISSIONS.member },
    });
    expect((await t.call("/v1/previews/p1", { method: "DELETE", as: session })).status).toBe(200);
  });

  test("admin is 409, an unknown role 404, an unknown permission 422 -- and nothing was changed by any of them", async () => {
    const t = await make();
    const put = (role: string, permissions: unknown) =>
      t.call(`/v1/roles/${role}/permissions`, { method: "PUT", as: t.ada, json: { permissions } });
    expect((await put("admin", [])).status).toBe(409);
    expect((await put("ghost", [])).status).toBe(404);
    expect((await put("viewer", ["previews.read", "previews.levitate"])).status).toBe(422);
    expect((await put("viewer", "everything")).status).toBe(422);
    expect([...t.s.roles.for("viewer")].sort()).toEqual(
      [...DEFAULT_ROLE_PERMISSIONS.viewer].sort(),
    );
    expect(t.s.roles.for("admin").size).toBe(ALL_PERMISSIONS.length);
  });

  test("a role can be emptied; its people can still log in, and can do nothing", async () => {
    const t = await make();
    await t.addUser("vic@example.com", "viewer");
    expect(
      (
        await t.call("/v1/roles/viewer/permissions", {
          method: "PUT",
          as: t.ada,
          json: { permissions: [] },
        })
      ).status,
    ).toBe(200);
    const vic = await t.login("vic@example.com");
    expect(await (await t.call("/v1/auth/session", { as: vic })).json()).toMatchObject({
      authenticated: true,
      permissions: [],
    });
  });

  test("only roles.manage may edit, and the edit is audited with the whole before and after", async () => {
    const t = await make();
    await t.addUser("bob@example.com", "member");
    const bob = await t.login("bob@example.com");
    expect((await t.call("/v1/roles", { as: bob })).status).toBe(403);
    expect(
      (
        await t.call("/v1/roles/member/permissions", {
          method: "PUT",
          as: bob,
          json: { permissions: [...ALL_PERMISSIONS] },
        })
      ).status,
    ).toBe(403);

    await t.call("/v1/roles/viewer/permissions", {
      method: "PUT",
      as: t.ada,
      json: { permissions: ["previews.read"] },
    });
    expect(t.s.auditRepo.page({ limit: 1 }).entries[0]).toMatchObject({
      actorType: "user",
      action: "role.permissions.changed",
      target: "viewer",
      old: { permissions: [...DEFAULT_ROLE_PERMISSIONS.viewer].sort() },
      new: { permissions: ["previews.read"] },
    });
  });

  test("the env admin token can edit roles too: the matrix is recoverable with no account at all", async () => {
    const t = await make();
    expect(
      (
        await t.call("/v1/roles/viewer/permissions", {
          method: "PUT",
          as: ENV_TOKEN,
          json: { permissions: ["previews.read"] },
        })
      ).status,
    ).toBe(200);
    expect(t.s.auditRepo.page({ limit: 1 }).entries[0]).toMatchObject({
      actorType: "token",
      actorId: "env:admin",
    });
  });
});
