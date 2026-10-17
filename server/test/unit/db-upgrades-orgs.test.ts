import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.ts";
import { HOME_ORG_ID, OrgsRepo } from "../../src/db/repos/orgs.ts";
import { ProjectsRepo } from "../../src/db/repos/projects.ts";
import type { Db } from "../../src/db/types.ts";
import { MIGRATIONS, tempDir } from "../helpers/db.ts";
import { DRIVERS, databaseAt, versionsFrom } from "../helpers/db-migrations.ts";

// The upgrades since organisations: split from db-upgrades.test.ts, which holds the earlier ones.

const grants = (db: Db, role: string) =>
  (
    db.query(
      "SELECT permission_id FROM role_permissions WHERE role_id = $r ORDER BY permission_id",
      { r: role },
    ) as { permission_id: string }[]
  ).map((r) => r.permission_id);

for (const [name, open] of DRIVERS) {
  const migrated = () => {
    const { db } = open({ path: join(tempDir(), "g.db") });
    migrate(db, MIGRATIONS);
    return db;
  };

  describe(`0029 orgs on ${name}`, () => {
    test("an existing install becomes one home org, and there can be only one", () => {
      const at = databaseAt(open, 28);
      at.db.run(
        "INSERT INTO users (id, email, password_hash, password_salt, role_id, created_at) VALUES ('u1', 'ada@example.com', 'h', 's', 'admin', 1)",
      );
      const db = at.reopen();
      expect(migrate(db, MIGRATIONS).applied).toEqual(versionsFrom(29));
      const orgs = new OrgsRepo(db);
      expect(orgs.list().map((o) => [o.id, o.slug, o.home, o.state])).toEqual([
        [HOME_ORG_ID, "default", true, "active"],
      ]);
      const org = (id: string, slug: string, home: number) =>
        db.run(
          `INSERT INTO orgs (id, slug, name, home, created_at, updated_at) VALUES ('${id}', '${slug}', 'x', ${home}, 1, 1)`,
        );
      expect(() => org("o2", "second", 1)).toThrow();
      expect(() => org("o2", "a-b", 0)).toThrow();
      expect(() => org("o2", "Caps", 0)).toThrow();
      org("o2", "acme2", 0);
      expect(orgs.home().id).toBe(HOME_ORG_ID);
      db.close();
    });

    test("limits replace as a whole, and an org with none has no limit", () => {
      const db = migrated();
      const orgs = new OrgsRepo(db, () => 5);
      expect(orgs.limitsOf(HOME_ORG_ID)).toBeUndefined();
      orgs.setLimits(
        HOME_ORG_ID,
        "Pro",
        { storageBytes: 5e9, maxAwake: 2, containers: true },
        "t1",
      );
      orgs.setLimits(HOME_ORG_ID, "Free", { storageBytes: 25e7, containers: false }, "t1");
      expect(orgs.limitsOf(HOME_ORG_ID)).toEqual({
        planLabel: "Free",
        limits: { storageBytes: 25e7, containers: false },
        updatedAt: 5,
      });
      expect(() => orgs.setLimits(HOME_ORG_ID, null, { maxAwake: -1 }, "t1")).toThrow();
      db.close();
    });
  });

  describe(`0031 project repository id on ${name}`, () => {
    test("the first id a run shows sticks, and changing the repository forgets it", () => {
      const db = migrated();
      const projects = new ProjectsRepo(db);
      projects.create({ id: "p1", orgId: HOME_ORG_ID, name: "web", slug: "web" });
      projects.setRepository("p1", "github", "acme/web");
      expect(projects.sameRepository("p1", "100")).toBe(true);
      expect(projects.sameRepository("p1", "100")).toBe(true);
      expect(projects.sameRepository("p1", "200")).toBe(false);
      projects.setRepository("p1", "github", "acme/site");
      expect(projects.sameRepository("p1", "200")).toBe(true);
      db.close();
    });
  });

  describe(`0032 memberships on ${name}`, () => {
    test("every existing person belongs to the home org with the role they had", () => {
      const at = databaseAt(open, 31);
      at.db.run(
        "INSERT INTO users (id, email, password_hash, password_salt, role_id, created_at) VALUES ('u1', 'ada@example.com', 'h', 's', 'admin', 1), ('u2', 'bo@example.com', 'h', 's', 'viewer', 2)",
      );
      const db = at.reopen();
      expect(migrate(db, MIGRATIONS).applied).toEqual(versionsFrom(32));
      expect(db.query("SELECT org_id, user_id, role_id FROM memberships ORDER BY user_id")).toEqual(
        [
          { org_id: HOME_ORG_ID, user_id: "u1", role_id: "admin" },
          { org_id: HOME_ORG_ID, user_id: "u2", role_id: "viewer" },
        ],
      );
      db.close();
    });
  });

  describe(`0033 org copies on ${name}`, () => {
    test("the builtin roles take their kind, and a custom role keeps none", () => {
      const at = databaseAt(open, 32);
      at.db.run("INSERT INTO roles (id, name, created_at) VALUES ('fixer', 'fixer', 1)");
      const db = at.reopen();
      expect(migrate(db, MIGRATIONS).applied).toEqual(versionsFrom(33));
      expect(db.query("SELECT id, kind FROM roles ORDER BY id")).toEqual([
        { id: "admin", kind: "admin" },
        { id: "fixer", kind: null },
        { id: "member", kind: "member" },
        { id: "viewer", kind: "viewer" },
      ]);
      db.close();
    });
  });

  describe(`0037 takedowns on ${name}`, () => {
    test("joining or leaving an org, by a deleted account too, moves its updated_at", () => {
      const at = databaseAt(open, 36);
      at.db.run("UPDATE orgs SET updated_at = 1");
      const db = at.reopen();
      expect(migrate(db, MIGRATIONS).applied).toEqual(versionsFrom(37));
      const updated = () =>
        (db.get("SELECT updated_at FROM orgs WHERE home = 1") as { updated_at: number }).updated_at;
      db.run(
        "INSERT INTO users (id, email, password_hash, password_salt, role_id, created_at) VALUES ('u1', 'ada@example.com', 'h', 's', 'admin', 1)",
      );
      db.run(
        `INSERT INTO memberships (org_id, user_id, role_id, created_at) VALUES ('${HOME_ORG_ID}', 'u1', 'admin', 1)`,
      );
      expect(updated()).toBeGreaterThan(1);
      // Ahead of the clock, as a second change in the same millisecond would be: it still moves.
      const ahead = Date.now() + 60_000;
      db.run(`UPDATE orgs SET updated_at = ${ahead}`);
      db.run("DELETE FROM users WHERE id = 'u1'");
      expect(updated()).toBe(ahead + 1);
      db.close();
    });
  });

  describe(`0038 org settings on ${name}`, () => {
    test("server settings stay put; who held them gets an org's own", () => {
      const at = databaseAt(open, 37);
      at.db.run(
        `INSERT INTO settings (key, value_json, updated_at) VALUES ('previews.watermark', 'false', 1)`,
      );
      at.db.run("INSERT INTO roles (id, org_id, name, created_at) VALUES ('ops', $o, 'ops', 1)", {
        o: HOME_ORG_ID,
      });
      at.db.run(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES ('ops', 'settings.read')",
      );
      const db = at.reopen();
      expect(migrate(db, MIGRATIONS).applied).toEqual(versionsFrom(38));
      expect(db.query("SELECT key, value_json FROM settings")).toEqual([
        { key: "previews.watermark", value_json: "false" },
      ]);
      expect(db.query("SELECT * FROM org_settings")).toEqual([]);
      expect(grants(db, "ops")).toEqual(["settings.org_read", "settings.read"]);
      expect(grants(db, "admin")).toContain("settings.org_write");
      expect(grants(db, "member")).not.toContain("settings.org_read");
      db.close();
    });
  });
}
