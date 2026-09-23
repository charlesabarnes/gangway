import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
} from "../../../shared/src/permissions.ts";
import { RolePermissions } from "../../src/auth/roles.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
  AuditRepo,
  RolesRepo,
  SessionsRepo,
  TokensRepo,
  UsersRepo,
} from "../../src/db/repos/index.ts";
import { openDatabase as openBun } from "../../src/db/sqlite.ts";
import { openDatabase as openNode } from "../../src/db/sqlite.node.ts";
import type { Db, OpenOptions } from "../../src/db/types.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DRIVERS: [string, (o: OpenOptions) => { db: Db }][] = [
  ["bun", openBun],
  ["node", openNode],
];
const MIN = 60_000,
  DAY = 86_400_000;

for (const [name, open] of DRIVERS) {
  describe(`account repos (${name})`, () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;

    const setup = () => {
      clock = 1_700_000_000_000;
      const d = mkdtempSync(join(tmpdir(), "gangway-acct-"));
      tmps.push(d);
      const { db } = open({ path: join(d, "g.db") });
      migrate(db, MIGRATIONS, now);
      const users = new UsersRepo(db, now);
      const ada = () =>
        users.create({
          id: "u-ada",
          email: "ada@example.com",
          roleId: "admin",
          hash: "scrypt$x",
          salt: "s",
        });
      return {
        db,
        users,
        ada,
        sessions: new SessionsRepo(db, now),
        tokens: new TokensRepo(db, now),
        audit: new AuditRepo(db, now),
        roles: new RolesRepo(db),
      };
    };

    describe("users", () => {
      test("a User never carries password material; credentials() is the only way to it", () => {
        const { users, ada } = setup();
        const u = ada();
        expect(u).toEqual({
          id: "u-ada",
          email: "ada@example.com",
          roleId: "admin",
          disabled: false,
          createdAt: new Date(clock),
        });
        expect(
          JSON.stringify([u, users.list(), users.getByEmail("ada@example.com")]),
        ).not.toContain("scrypt");
        expect(users.credentials("u-ada")).toEqual({ hash: "scrypt$x", salt: "s" });
      });

      test("a missing row is undefined on both drivers, never null", () => {
        const { users, sessions, tokens, roles } = setup();
        expect(users.get("nope")).toBeUndefined();
        expect(users.getByEmail("nope@example.com")).toBeUndefined();
        expect(users.credentials("nope")).toBeUndefined();
        expect(sessions.findActive("nope")).toBeUndefined();
        expect(tokens.get("nope")).toBeUndefined();
        expect(tokens.findActiveByHash("nope")).toBeUndefined();
        expect(roles.get("nope")).toBeUndefined();
      });

      test("email is unique, and a role must exist", () => {
        const { users, ada } = setup();
        ada();
        expect(() =>
          users.create({
            id: "u-2",
            email: "ada@example.com",
            roleId: "viewer",
            hash: "h",
            salt: "s",
          }),
        ).toThrow();
        expect(() =>
          users.create({
            id: "u-3",
            email: "bob@example.com",
            roleId: "wizard",
            hash: "h",
            salt: "s",
          }),
        ).toThrow();
        expect(users.count()).toBe(1);
      });

      test("countActiveAdmins answers the last-admin question", () => {
        const { users, ada } = setup();
        ada();
        users.create({
          id: "u-bob",
          email: "bob@example.com",
          roleId: "member",
          hash: "h",
          salt: "s",
        });
        expect(users.countActiveAdmins()).toBe(1);
        expect(users.countActiveAdmins("u-ada")).toBe(0); // who is left if ada stops being one? nobody.
        users.update("u-bob", { roleId: "admin" });
        expect(users.countActiveAdmins("u-ada")).toBe(1);
        users.update("u-bob", { disabled: true });
        expect(users.countActiveAdmins("u-ada")).toBe(0); // a disabled admin is not a way back in
      });

      test("update touches only what it is given", () => {
        const { users, ada } = setup();
        ada();
        expect(users.update("u-ada", { disabled: true })).toMatchObject({
          roleId: "admin",
          disabled: true,
        });
        expect(users.update("u-ada", { roleId: "viewer" })).toMatchObject({
          roleId: "viewer",
          disabled: true,
        });
        expect(users.update("nope", { disabled: true })).toBeUndefined();
      });
    });

    describe("sessions", () => {
      const open1 = (s: ReturnType<typeof setup>) => {
        s.ada();
        return s.sessions.create({
          id: "h1",
          userId: "u-ada",
          expiresAt: clock + 7 * DAY,
          ip: "::1",
          userAgent: "curl",
        });
      };

      test("findActive returns the session with its account, and refuses expired and disabled", () => {
        const s = setup();
        open1(s);
        const found = s.sessions.findActive("h1")!;
        expect(found.user).toMatchObject({ id: "u-ada", roleId: "admin" });
        expect(found.session).toMatchObject({ userId: "u-ada", ip: "::1", userAgent: "curl" });

        s.users.update("u-ada", { disabled: true });
        expect(s.sessions.findActive("h1")).toBeUndefined();
        s.users.update("u-ada", { disabled: false });
        clock += 7 * DAY;
        expect(s.sessions.findActive("h1")).toBeUndefined();
      });

      test("touch is throttled: nothing is written inside the window", () => {
        const s = setup();
        open1(s);
        const o = { idleMs: 7 * DAY, absoluteMs: 30 * DAY };
        clock += 4 * MIN;
        expect(s.sessions.touch("h1", { ...o, staleBefore: clock - 5 * MIN })).toBe(false);
        clock += 2 * MIN;
        expect(s.sessions.touch("h1", { ...o, staleBefore: clock - 5 * MIN })).toBe(true);
        expect(s.sessions.findActive("h1")!.session.expiresAt.getTime()).toBe(clock + 7 * DAY);
      });

      test("sliding never passes the absolute cap", () => {
        const s = setup();
        const created = open1(s).createdAt.getTime();
        clock += 29 * DAY;
        s.db.run("UPDATE sessions SET expires_at = $e WHERE id = 'h1'", { e: clock + DAY }); // kept alive by use until now
        expect(
          s.sessions.touch("h1", { staleBefore: clock, idleMs: 7 * DAY, absoluteMs: 30 * DAY }),
        ).toBe(true);
        expect(s.sessions.findActive("h1")!.session.expiresAt.getTime()).toBe(created + 30 * DAY);
      });

      test("deleteForUser can spare the current session; purgeExpired takes only the dead", () => {
        const s = setup();
        open1(s);
        s.sessions.create({
          id: "h2",
          userId: "u-ada",
          expiresAt: clock + DAY,
          ip: null,
          userAgent: null,
        });
        s.sessions.create({
          id: "h3",
          userId: "u-ada",
          expiresAt: clock + MIN,
          ip: null,
          userAgent: null,
        });
        clock += 2 * MIN;
        expect(s.sessions.purgeExpired()).toBe(1);
        expect(s.sessions.deleteForUser("u-ada", "h1")).toBe(1);
        expect(s.sessions.findActive("h1")).toBeDefined();
        expect(s.sessions.deleteForUser("u-ada")).toBe(1);
      });
    });

    describe("tokens", () => {
      const mint = (
        s: ReturnType<typeof setup>,
        over: Partial<Parameters<TokensRepo["create"]>[0]> = {},
      ) =>
        s.tokens.create({
          id: "t1",
          name: "ci",
          prefix: "gw_abcdefgh",
          tokenHash: "hash-1",
          scopes: ["deploy"],
          userId: "u-ada",
          expiresAt: null,
          ...over,
        });

      test("the hash never appears in a domain object", () => {
        const s = setup();
        s.ada();
        const t = mint(s);
        expect(t).toMatchObject({
          id: "t1",
          name: "ci",
          prefix: "gw_abcdefgh",
          scopes: ["deploy"],
          userId: "u-ada",
          revokedAt: null,
          lastUsedAt: null,
        });
        expect(
          JSON.stringify([
            t,
            s.tokens.listAll(),
            s.tokens.listForUser("u-ada"),
            s.tokens.findActiveByHash("hash-1"),
          ]),
        ).not.toContain("hash-1");
      });

      test("findActiveByHash returns the owner, and refuses revoked, expired and disabled-owner tokens", () => {
        const s = setup();
        s.ada();
        mint(s, { expiresAt: clock + DAY });
        expect(s.tokens.findActiveByHash("hash-1")!.owner).toMatchObject({
          id: "u-ada",
          roleId: "admin",
        });

        s.users.update("u-ada", { disabled: true });
        expect(s.tokens.findActiveByHash("hash-1")).toBeUndefined();
        s.users.update("u-ada", { disabled: false });

        clock += DAY;
        expect(s.tokens.findActiveByHash("hash-1")).toBeUndefined();
        clock -= DAY;

        expect(s.tokens.revoke("t1")).toBe(true);
        expect(s.tokens.revoke("t1")).toBe(false);
        expect(s.tokens.findActiveByHash("hash-1")).toBeUndefined();
        expect(s.tokens.get("t1")!.revokedAt).toEqual(new Date(clock)); // still there for the audit trail
      });

      test("an ownerless token is active with a null owner", () => {
        const s = setup();
        mint(s, { userId: null, scopes: ["admin"] });
        expect(s.tokens.findActiveByHash("hash-1")).toMatchObject({
          owner: null,
          token: { scopes: ["admin"] },
        });
      });

      test("touch is throttled", () => {
        const s = setup();
        mint(s, { userId: null });
        expect(s.tokens.touch("t1", clock - MIN)).toBe(true);
        clock += 30_000;
        expect(s.tokens.touch("t1", clock - MIN)).toBe(false);
        clock += 31_000;
        expect(s.tokens.touch("t1", clock - MIN)).toBe(true);
      });

      test("hasActiveAdmin: an owned admin token counts only while its owner is an enabled admin", () => {
        const s = setup();
        s.ada();
        expect(s.tokens.hasActiveAdmin()).toBe(false);
        mint(s, { scopes: ["deploy"] });
        expect(s.tokens.hasActiveAdmin()).toBe(false);
        mint(s, { id: "t2", tokenHash: "hash-2", scopes: ["read", "admin"] });
        expect(s.tokens.hasActiveAdmin()).toBe(true);
        s.users.update("u-ada", { roleId: "member" });
        expect(s.tokens.hasActiveAdmin()).toBe(false);
        mint(s, { id: "t3", tokenHash: "hash-3", scopes: ["admin"], userId: null });
        expect(s.tokens.hasActiveAdmin()).toBe(true);
        s.tokens.revoke("t3");
        expect(s.tokens.hasActiveAdmin()).toBe(false);
      });
    });

    describe("audit", () => {
      test("pages newest-first with a cursor, and filters by action", () => {
        const { audit } = setup();
        for (let i = 1; i <= 5; i++) {
          clock += 1;
          audit.append({
            actorType: "user",
            actorId: "u-ada",
            action: i % 2 ? "auth.login" : "preview.deploy",
            target: `t${i}`,
            new: { i },
          });
        }

        const first = audit.page({ limit: 2 });
        expect(first.entries.map((e) => e.target)).toEqual(["t5", "t4"]);
        expect(first.entries[0]).toMatchObject({
          actorType: "user",
          actorId: "u-ada",
          old: null,
          new: { i: 5 },
        });
        const second = audit.page({ limit: 2, before: first.nextBefore! });
        expect(second.entries.map((e) => e.target)).toEqual(["t3", "t2"]);
        const last = audit.page({ limit: 2, before: second.nextBefore! });
        expect(last.entries.map((e) => e.target)).toEqual(["t1"]);
        expect(last.nextBefore).toBeNull();

        expect(
          audit.page({ limit: 10, action: "auth.login" }).entries.map((e) => e.target),
        ).toEqual(["t5", "t3", "t1"]);
      });

      test("an actor type the schema does not know is refused", () => {
        const { audit } = setup();
        expect(() =>
          audit.append({ actorType: "martian" as never, actorId: null, action: "x", target: null }),
        ).toThrow();
      });
    });

    describe("roles and the permission matrix", () => {
      test("the seeded matrix is what the code's defaults say, and admin is everything", () => {
        const rp = new RolePermissions(setup().roles);
        expect([...rp.for("member")].sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS.member].sort());
        expect([...rp.for("viewer")].sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS.viewer].sort());
        expect([...rp.for("admin")].sort()).toEqual([...ALL_PERMISSIONS].sort());
        expect(rp.for("no-such-role").size).toBe(0);
        expect(rp.roles().map((r) => [r.id, r.builtin, r.editable])).toEqual([
          ["admin", true, false],
          ["member", true, true],
          ["viewer", true, true],
        ]);
      });

      test("an edit replaces the set, reports old and new, and survives a reload from SQLite", () => {
        const { roles } = setup();
        const rp = new RolePermissions(roles);
        const change = rp.set("viewer", ["previews.read", "audit.read", "previews.read"]);
        expect(change.old).toEqual([...DEFAULT_ROLE_PERMISSIONS.viewer].sort());
        expect(change.new).toEqual(["audit.read", "previews.read"]);
        expect(rp.for("viewer").has("logs.read")).toBe(false);
        expect([...new RolePermissions(roles).for("viewer")].sort()).toEqual([
          "audit.read",
          "previews.read",
        ]);
        rp.set("viewer", []);
        expect(rp.for("viewer").size).toBe(0);
      });

      test("admin cannot be edited -- not through the API, and not by hand in SQLite", () => {
        const { roles, db } = setup();
        const rp = new RolePermissions(roles);
        expect(() => rp.set("admin", [])).toThrow(/cannot be edited/);
        expect(() => rp.set("ghost", [])).toThrow(/no such role/);
        db.run("DELETE FROM role_permissions WHERE role_id = 'admin'");
        rp.reload();
        expect(rp.for("admin").size).toBe(ALL_PERMISSIONS.length);
      });

      test("syncCatalogue adds what the code has learned, grants it to admin, and leaves the operator's matrix alone", () => {
        const { roles, db } = setup();
        const rp = new RolePermissions(roles);
        rp.set("member", ["previews.read"]);
        const grown = [
          ...PERMISSIONS,
          { id: "previews.clone", feature: "previews", description: "a later phase" },
        ];
        expect(roles.syncCatalogue(grown).added).toEqual(["previews.clone"]);
        expect(roles.syncCatalogue(grown).added).toEqual([]);
        expect(
          db.get<{ ok: number }>(
            "SELECT 1 AS ok FROM role_permissions WHERE role_id = 'admin' AND permission_id = 'previews.clone'",
          ),
        ).toEqual({ ok: 1 });
        rp.reload();
        expect([...rp.for("member")]).toEqual(["previews.read"]);
      });

      test("a grant on an id the code does not know is inert: it is never served", () => {
        const { roles, db } = setup();
        db.run("INSERT INTO permissions (id, feature) VALUES ('previews.retired', 'previews')");
        db.run(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES ('viewer', 'previews.retired')",
        );
        expect([...new RolePermissions(roles).for("viewer")]).not.toContain("previews.retired");
      });
    });
  });
}
