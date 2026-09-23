import { describe, expect, test } from "bun:test";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from "@gangway/shared/permissions";
import { requirePermission } from "../../src/app/middleware/auth.ts";
import { roleRoutes } from "../../src/app/routes/roles.ts";
import { tokenRoutes } from "../../src/app/routes/tokens.ts";
import { userRoutes } from "../../src/app/routes/users.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { signedInApp } from "../helpers/http.ts";

const ENV_TOKEN = "gw_users_roles_env_token_0123456789";

async function make() {
  const s = setupAccounts();
  const { call, login, ada } = await signedInApp(s, {
    envToken: ENV_TOKEN,
    v1: (api, tokens) => {
      userRoutes(api, s.accounts);
      roleRoutes(api, s.roles);
      tokenRoutes(api, tokens);
      api.delete("/previews/:id", requirePermission("previews.destroy"), (c) =>
        c.json({ destroyed: c.req.param("id") }),
      );
    },
  });
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
  test("an admin creates, lists, re-roles and disables, and never sees password material", async () => {
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

  test.each([
    ["an unknown role", { email: "c@example.com", password: PASSWORD, roleId: "wizard" }, 422],
    ["a duplicate email", { email: "bob@example.com", password: PASSWORD, roleId: "member" }, 409],
    ["a short password", { email: "c@example.com", password: "short", roleId: "member" }, 422],
    [
      "an extra field",
      { email: "c@example.com", password: PASSWORD, roleId: "member", admin: true },
      422,
    ],
  ])("create with %s is refused", async (_, json, status) => {
    const t = await make();
    await t.addUser("bob@example.com", "member");
    expect((await t.call("/v1/users", { method: "POST", as: t.ada, json })).status).toBe(status);
  });

  test("an empty patch is 422 and an unknown user 404", async () => {
    const t = await make();
    const bob = await t.addUser("bob@example.com", "member");
    expect(
      (await t.call(`/v1/users/${bob.id}`, { method: "PATCH", as: t.ada, json: {} })).status,
    ).toBe(422);
    expect(
      (await t.call("/v1/users/nobody", { method: "PATCH", as: t.ada, json: { disabled: true } }))
        .status,
    ).toBe(404);
  });

  test("the last enabled admin cannot demote or disable themselves", async () => {
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

  test("shows the seeded roles, what each grants, and everything that can be granted", async () => {
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

  test("an edit reaches a member's open session and token on their next request", async () => {
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

  test("refuses admin, an unknown role and an unknown permission, changing nothing", async () => {
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

  test("only roles.manage may edit, and the audit holds the whole before and after", async () => {
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

  test("the env admin token can edit roles, so the matrix needs no account to recover", async () => {
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
