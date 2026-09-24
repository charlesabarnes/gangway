import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_ROLE_PERMISSIONS, isPermission } from "@gangway/shared/permissions";
import { migrate } from "../../src/db/migrate.ts";
import type { Db } from "../../src/db/types.ts";
import { MIGRATIONS, tempDir } from "../helpers/db.ts";
import { DRIVERS, databaseAt, migrationsUpTo } from "../helpers/db-migrations.ts";

const HOST =
  "INSERT INTO hosts (id, name, docker_host, capabilities, publish_bind, upstream_dial, upstream_address, port_range_start, port_range_end, created_at) VALUES ('local', 'local', 'unix:///x', '[\"preview\"]', '127.0.0.1', 'direct', '127.0.0.1', 31000, 31099, 1)";

const REPOS_AT_0006 =
  "INSERT INTO repos (id, forge, full_name, slug, pr_clearance, fork_clearance, visibility, env_ciphertext, created_at, updated_at) VALUES ('r1', 'github', 'acme/a', 'a', 'standard', 'none', 'public', 'sealed', 1, 1), ('r2', 'github', 'acme/b', 'b', 'high', 'low', NULL, NULL, 1, 1)";

const grants = (db: Db, role: string) =>
  db
    .query<{ permission_id: string }>(
      "SELECT permission_id FROM role_permissions WHERE role_id = $r ORDER BY permission_id",
      { r: role },
    )
    .map((r) => r.permission_id);

for (const [name, open] of DRIVERS) {
  const migrated = () => {
    const { db } = open({ path: join(tempDir(), "g.db") });
    migrate(db, MIGRATIONS);
    return db;
  };

  describe(`0003 roles and permissions on ${name}`, () => {
    test("seeds three builtin roles, with member and viewer at the code's defaults", () => {
      const db = migrated();
      expect(
        db.query<{ id: string; builtin: number }>("SELECT id, builtin FROM roles ORDER BY id"),
      ).toEqual([
        { id: "admin", builtin: 1 },
        { id: "member", builtin: 1 },
        { id: "viewer", builtin: 1 },
      ]);
      expect(grants(db, "member")).toEqual([...DEFAULT_ROLE_PERMISSIONS.member].sort());
      expect(grants(db, "viewer")).toEqual([...DEFAULT_ROLE_PERMISSIONS.viewer].sort());
      db.close();
    });

    test("every seeded permission still exists in code, so no id was renamed", () => {
      const db = migrated();
      const seeded = db.query<{ id: string }>("SELECT id FROM permissions").map((r) => r.id);
      expect(seeded.length).toBeGreaterThan(20);
      for (const id of seeded) expect(isPermission(id)).toBe(true);
      expect(grants(db, "admin")).toEqual([...seeded].sort());
      db.close();
    });

    test("a grant needs a real role and permission; a role in use cannot be deleted", () => {
      const db = migrated();
      const user = (role: string) =>
        db.run(
          `INSERT INTO users (id, email, password_hash, password_salt, role_id, created_at) VALUES ('u', 'a@b.c', 'h', 's', '${role}', 1)`,
        );
      expect(() =>
        db.run(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES ('viewer', 'previews.levitate')",
        ),
      ).toThrow();
      expect(() =>
        db.run(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES ('ghost', 'previews.read')",
        ),
      ).toThrow();
      expect(() => user("ghost")).toThrow();
      user("viewer");
      expect(() => db.run("DELETE FROM roles WHERE id = 'viewer'")).toThrow();
      db.close();
    });

    test("upgrading from 0002 keeps each user's role and each session and token owner", () => {
      const at = databaseAt(open, 2);
      expect(at.applied).toEqual([1, 2]);
      at.db.run(
        "INSERT INTO users (id, email, password_hash, password_salt, role, disabled, created_at) VALUES ('u1', 'ada@example.com', 'h', 's', 'member', 1, 42)",
      );
      at.db.run(
        "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', 'u1', 1, 2)",
      );
      at.db.run(
        "INSERT INTO api_tokens (id, name, prefix, token_hash, user_id, created_at) VALUES ('t1', 'ci', 'gw_abc', 'hash', 'u1', 1)",
      );

      const db = at.reopen();
      expect(migrate(db, MIGRATIONS).applied).toEqual([
        3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
      ]);
      expect(
        db.get<Record<string, unknown>>(
          "SELECT id, email, role_id, disabled, created_at FROM users",
        ),
      ).toEqual({
        id: "u1",
        email: "ada@example.com",
        role_id: "member",
        disabled: 1,
        created_at: 42,
      });
      expect(db.query("PRAGMA foreign_key_check")).toEqual([]);
      expect(Number(db.pragma<any>("PRAGMA foreign_keys")!.foreign_keys)).toBe(1);
      // The children followed the table rename: deleting the user still cascades to both.
      db.run("DELETE FROM users WHERE id = 'u1'");
      expect(db.query("SELECT id FROM sessions")).toEqual([]);
      expect(db.query("SELECT id FROM api_tokens")).toEqual([]);
      db.close();
    });
  });

  describe(`0007 templates on ${name}`, () => {
    test("a fresh database has the built-in template at the old defaults", () => {
      const db = migrated();
      expect(
        db.get<Record<string, unknown>>(
          "SELECT id, builtin, visibility, ttl, idle_after, clearance, host_id FROM templates",
        ),
      ).toEqual({
        id: "default",
        builtin: 1,
        visibility: "unlisted",
        ttl: "7d",
        idle_after: "30m",
        clearance: "standard",
        host_id: null,
      });
      expect(() =>
        db.run(
          "INSERT INTO templates (id, name, visibility, created_at, updated_at) VALUES ('Bad Id', 'x', 'public', 1, 1)",
        ),
      ).toThrow();
      db.close();
    });

    test("upgrading from 0006 turns the defaults.* settings into the default template", () => {
      const at = databaseAt(open, 6);
      expect(at.applied).toEqual([1, 2, 3, 4, 5, 6]);
      at.db.run(
        "INSERT INTO settings (key, value_json, updated_at) VALUES ('defaults.ttl', '\"3d\"', 1), ('defaults.visibility', '\"private\"', 1), ('secrets.defaultClearance', '\"low\"', 1), ('baseDomain', '\"x.test\"', 1)",
      );
      at.db.run(REPOS_AT_0006);

      const db = at.reopen();
      expect(migrate(db, migrationsUpTo(7)).applied).toEqual([7]);
      expect(
        db.get<Record<string, unknown>>(
          "SELECT visibility, ttl, idle_after, clearance FROM templates WHERE id = 'default'",
        ),
      ).toEqual({ visibility: "private", ttl: "3d", idle_after: "30m", clearance: "low" });
      expect(
        db.query<{ key: string }>("SELECT key FROM settings ORDER BY key").map((r) => r.key),
      ).toEqual(["baseDomain"]);
      // r1 was at the old column default and now follows its template; r2 chose "high" and keeps it.
      expect(
        db.query<Record<string, unknown>>(
          "SELECT id, template_id, pr_clearance, fork_clearance, visibility, env_ciphertext FROM repos ORDER BY id",
        ),
      ).toEqual([
        {
          id: "r1",
          template_id: null,
          pr_clearance: null,
          fork_clearance: "none",
          visibility: "public",
          env_ciphertext: "sealed",
        },
        {
          id: "r2",
          template_id: null,
          pr_clearance: "high",
          fork_clearance: "low",
          visibility: null,
          env_ciphertext: null,
        },
      ]);
      expect(db.query("PRAGMA foreign_key_check")).toEqual([]);
      db.close();
    });

    test("a deleted template leaves its repositories on the default", () => {
      const at = databaseAt(open, 6);
      at.db.run(REPOS_AT_0006);
      const db = at.reopen();
      migrate(db, migrationsUpTo(7));
      db.run(
        "INSERT INTO templates (id, name, visibility, created_at, updated_at) VALUES ('staging', 'Staging', 'public', 1, 1)",
      );
      db.run("UPDATE repos SET template_id = 'staging' WHERE id = 'r1'");
      expect(() => db.run("UPDATE repos SET template_id = 'ghost' WHERE id = 'r2'")).toThrow();
      db.run("DELETE FROM templates WHERE id = 'staging'");
      expect(
        db.get<{ template_id: string | null }>("SELECT template_id FROM repos WHERE id = 'r1'")!
          .template_id,
      ).toBeNull();
      db.close();
    });
  });

  describe(`0008 projects on ${name}`, () => {
    test("upgrading from 0007 makes each repository a project that keeps its settings", () => {
      const at = databaseAt(open, 7);
      at.db.run(HOST);
      at.db.run(
        "INSERT INTO repos (id, forge, full_name, installation_id, slug, pr_clearance, fork_clearance, visibility, template_id, env_ciphertext, created_at, updated_at) VALUES ('r1', 'github', 'acme/store-admin', '42', 'store-admin', 'high', 'none', 'private', 'default', 'sealed', 1, 1)",
      );
      at.db.run(
        "INSERT INTO previews (id, project, host_id, state, source_kind, source_json, visibility, created_at, updated_at) VALUES ('p1', 'gw-t-store-admin-pr-4', 'local', 'awake', 'pr', '{\"repo\":\"acme/store-admin\",\"number\":4,\"sha\":\"a\"}', 'unlisted', 1, 1), ('p2', 'gw-t-whoami', 'local', 'awake', 'image', '{\"image\":\"x\"}', 'public', 1, 1)",
      );

      const db = at.reopen();
      expect(migrate(db, MIGRATIONS).applied).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
      expect(
        db.get<Record<string, unknown>>(
          "SELECT id, name, slug, forge, full_name, installation_id, pr_trigger, template_id, visibility, pr_clearance, env_ciphertext FROM projects",
        ),
      ).toEqual({
        id: "r1",
        name: "store-admin",
        slug: "store-admin",
        forge: "github",
        full_name: "acme/store-admin",
        installation_id: "42",
        pr_trigger: "webhook",
        template_id: "default",
        visibility: "private",
        pr_clearance: "high",
        env_ciphertext: "sealed",
      });
      expect(
        db.query<Record<string, unknown>>("SELECT id, project_id FROM previews ORDER BY id"),
      ).toEqual([
        { id: "p1", project_id: "r1" },
        { id: "p2", project_id: null },
      ]);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'repos'")).toEqual([]);
      // A repository is both-or-neither: a forge with no full name is refused.
      expect(() =>
        db.run(
          "INSERT INTO projects (id, name, slug, forge, created_at, updated_at) VALUES ('x', 'x', 'x', 'github', 1, 1)",
        ),
      ).toThrow();
      db.run(
        "INSERT INTO projects (id, name, slug, created_at, updated_at) VALUES ('y', 'whoami', 'whoami', 1, 1)",
      );
      expect(db.query("PRAGMA foreign_key_check")).toEqual([]);
      db.close();
    });
  });

  describe(`0010 preview owner on ${name}`, () => {
    test("every role that could deploy, custom ones too, gets previews.update_own", () => {
      const at = databaseAt(open, 9);
      at.db.run(
        "INSERT INTO roles (id, name, description, builtin, created_at) VALUES ('ci', 'ci', 'CI only', 0, 1), ('auditor', 'auditor', 'looks', 0, 1)",
      );
      at.db.run(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES ('ci', 'previews.deploy'), ('auditor', 'previews.read')",
      );
      at.db.run(HOST);
      at.db.run(
        "INSERT INTO previews (id, project, host_id, state, source_kind, source_json, visibility, created_at, updated_at) VALUES ('p1', 'gw-t-x', 'local', 'awake', 'image', '{\"image\":\"x\"}', 'public', 1, 1)",
      );

      const db = at.reopen();
      expect(migrate(db, MIGRATIONS).applied).toEqual([10, 11, 12, 13, 14, 15]);
      const holders = db
        .query<{ role_id: string }>(
          "SELECT role_id FROM role_permissions WHERE permission_id = 'previews.update_own' ORDER BY role_id",
        )
        .map((r) => r.role_id);
      expect(holders).toEqual(["admin", "ci", "member"]);
      expect(
        db.get<{ owner: string | null }>("SELECT owner FROM previews WHERE id = 'p1'")!.owner,
      ).toBeNull();
      expect(db.query("PRAGMA foreign_key_check")).toEqual([]);
      db.close();
    });
  });
}
