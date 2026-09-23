import { describe, expect, test } from "bun:test";
import { copyFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase as openBun } from "../../src/db/sqlite.ts";
import { openDatabase as openNode } from "../../src/db/sqlite.node.ts";
import { compareVersion, type Db, type OpenOptions } from "../../src/db/types.ts";
import { checksum, loadMigrations, migrate } from "../../src/db/migrate.ts";
import { DEFAULT_ROLE_PERMISSIONS, isPermission } from "@gangway/shared/permissions";
import { MIGRATIONS, tempDir } from "../helpers/db.ts";

const DRIVERS: [string, (o: OpenOptions) => { db: Db; journalMode: string }][] = [
  ["bun:sqlite", openBun],
  ["node:sqlite", openNode],
];

describe("compareVersion", () => {
  test.each([
    ["3.51.0", true],
    ["3.53.3", true],
    ["3.38.0", true],
    ["3.37.9", false],
    ["3.7.0", false],
    ["4.0.0", true],
  ])("%s meets the floor: %s", (v, want) => expect(compareVersion(v, [3, 38, 0])).toBe(want));
});

// The whole suite runs against both drivers. That is the only thing that keeps the
// portability promise honest rather than aspirational.
for (const [name, open] of DRIVERS) {
  describe(`driver ${name}`, () => {
    const fresh = () => {
      const { db, journalMode } = open({ path: join(tempDir(), "g.db") });
      return { db, journalMode };
    };

    test("opens with WAL and foreign keys enforced", () => {
      const { db, journalMode } = fresh();
      expect(journalMode).toBe("wal");
      expect(Number(db.pragma<any>("PRAGMA foreign_keys")!.foreign_keys)).toBe(1);
      expect(compareVersion(db.sqliteVersion, [3, 38, 0])).toBe(true);
      db.close();
    });

    test("TRUNCATE is available as the FUSE fallback", () => {
      const { db, journalMode } = open({ path: join(tempDir(), "g.db"), journalMode: "TRUNCATE" });
      expect(journalMode).toBe("truncate");
      db.close();
    });

    test("named parameters, query/get/run", () => {
      const { db } = fresh();
      db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
      const r = db.run("INSERT INTO t (id, n) VALUES ($id, $n)", { id: "a", n: 1 });
      expect(r.changes).toBe(1);
      db.run("INSERT INTO t (id, n) VALUES ($id, $n)", { id: "b", n: 2 });
      expect(db.query<{ id: string }>("SELECT id FROM t ORDER BY id")).toEqual([
        { id: "a" },
        { id: "b" },
      ]);
      expect(db.get<{ n: number }>("SELECT n FROM t WHERE id = $id", { id: "b" })!.n).toBe(2);
      expect(db.get("SELECT n FROM t WHERE id = $id", { id: "zz" })).toBeUndefined();
      db.close();
    });

    test("foreign keys block and cascade", () => {
      const { db } = fresh();
      db.exec(`CREATE TABLE p (id TEXT PRIMARY KEY);
               CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT NOT NULL REFERENCES p(id) ON DELETE CASCADE)`);
      db.run("INSERT INTO p (id) VALUES ($id)", { id: "p1" });
      db.run("INSERT INTO c (id, p_id) VALUES ($id, $p_id)", { id: "c1", p_id: "p1" });
      expect(() =>
        db.run("INSERT INTO c (id, p_id) VALUES ($id, $p_id)", { id: "c2", p_id: "ghost" }),
      ).toThrow();
      db.run("DELETE FROM p WHERE id = $id", { id: "p1" });
      expect(db.query("SELECT * FROM c")).toHaveLength(0);
      db.close();
    });

    test("a transaction rolls back completely on throw", () => {
      const { db } = fresh();
      db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO t (id) VALUES ($id)", { id: "a" });
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(db.query("SELECT * FROM t")).toHaveLength(0);
      db.close();
    });

    test("the real 0001 schema applies and enforces its constraints", () => {
      const { db } = fresh();
      const res = migrate(db, MIGRATIONS);
      expect(res.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

      const now = Date.now();
      db.run(
        `INSERT INTO hosts (id, name, docker_host, created_at)
              VALUES ($id, $name, $dh, $now)`,
        { id: "local", name: "local", dh: "unix:///x", now },
      );
      db.run(
        `INSERT INTO previews (id, project, host_id, state, source_kind, created_at, updated_at)
              VALUES ($id, $p, 'local', 'building', 'image', $now, $now)`,
        { id: "pv1", p: "gw-1", now },
      );
      db.run(
        `INSERT INTO routes (hostname, preview_id, service, container_port, upstream_host, upstream_port, created_at)
              VALUES ($h, 'pv1', 'web', 3000, '127.0.0.1', 31000, $now)`,
        { h: "a.preview.test", now },
      );

      // hostname is the primary key, so a collision is a constraint violation
      expect(() =>
        db.run(
          `INSERT INTO routes (hostname, preview_id, service, container_port, upstream_host, upstream_port, created_at)
              VALUES ($h, 'pv1', 'api', 4000, '127.0.0.1', 31001, $now)`,
          { h: "a.preview.test", now },
        ),
      ).toThrow();

      // and one host port may not be claimed twice
      expect(() =>
        db.run(
          `INSERT INTO routes (hostname, preview_id, service, container_port, upstream_host, upstream_port, created_at)
              VALUES ($h, 'pv1', 'api', 4000, '127.0.0.1', 31000, $now)`,
          { h: "b.preview.test", now },
        ),
      ).toThrow();

      // an illegal state is rejected by the CHECK, not silently stored
      expect(() =>
        db.run(
          `INSERT INTO previews (id, project, host_id, state, source_kind, created_at, updated_at)
              VALUES ('x','gw-x','local','banana','image',$now,$now)`,
          { now },
        ),
      ).toThrow();

      // malformed JSON is rejected by json_valid()
      expect(() =>
        db.run(
          `INSERT INTO previews (id, project, host_id, state, source_kind, source_json, created_at, updated_at)
              VALUES ('y','gw-y','local','building','image','{oops',$now,$now)`,
          { now },
        ),
      ).toThrow();

      // destroying a preview cascades its routes away
      db.run("DELETE FROM previews WHERE id = 'pv1'");
      expect(db.query("SELECT * FROM routes")).toHaveLength(0);
      db.close();
    });

    test("migrate is idempotent across reopen", () => {
      const dir = tempDir();
      const a = open({ path: join(dir, "g.db") });
      expect(migrate(a.db, MIGRATIONS).applied).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      a.db.close();
      const b = open({ path: join(dir, "g.db") });
      const r = migrate(b.db, MIGRATIONS);
      expect(r.applied).toEqual([]);
      expect(r.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      b.db.close();
    });

    describe("0003 roles and permissions", () => {
      const grants = (db: Db, role: string) =>
        db
          .query<{ permission_id: string }>(
            "SELECT permission_id FROM role_permissions WHERE role_id = $r ORDER BY permission_id",
            { r: role },
          )
          .map((r) => r.permission_id);

      test("seeds three builtin roles, and member/viewer exactly as the code's defaults say", () => {
        const { db } = fresh();
        migrate(db, MIGRATIONS);
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

      test("every seeded permission still exists in code: an id is never renamed", () => {
        const { db } = fresh();
        migrate(db, MIGRATIONS);
        const seeded = db.query<{ id: string }>("SELECT id FROM permissions").map((r) => r.id);
        expect(seeded.length).toBeGreaterThan(20);
        for (const id of seeded) expect(isPermission(id)).toBe(true);
        expect(grants(db, "admin")).toEqual([...seeded].sort());
        db.close();
      });

      test("a grant must name a real role and a real permission; a role in use cannot be deleted", () => {
        const { db } = fresh();
        migrate(db, MIGRATIONS);
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
        expect(() =>
          db.run(
            "INSERT INTO users (id, email, password_hash, password_salt, role_id, created_at) VALUES ('u', 'a@b.c', 'h', 's', 'ghost', 1)",
          ),
        ).toThrow();
        db.run(
          "INSERT INTO users (id, email, password_hash, password_salt, role_id, created_at) VALUES ('u', 'a@b.c', 'h', 's', 'viewer', 1)",
        );
        expect(() => db.run("DELETE FROM roles WHERE id = 'viewer'")).toThrow();
        db.close();
      });

      test("upgrades a populated 0002 database: users keep their role, sessions and tokens keep their owner", () => {
        const upTo2 = tempDir();
        for (const f of readdirSync(MIGRATIONS))
          if (/^000[12]_/.test(f)) copyFileSync(join(MIGRATIONS, f), join(upTo2, f));
        const path = join(tempDir(), "g.db");
        const a = open({ path });
        expect(migrate(a.db, upTo2).applied).toEqual([1, 2]);
        a.db.run(
          "INSERT INTO users (id, email, password_hash, password_salt, role, disabled, created_at) VALUES ('u1', 'ada@example.com', 'h', 's', 'member', 1, 42)",
        );
        a.db.run(
          "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', 'u1', 1, 2)",
        );
        a.db.run(
          "INSERT INTO api_tokens (id, name, prefix, token_hash, user_id, created_at) VALUES ('t1', 'ci', 'gw_abc', 'hash', 'u1', 1)",
        );
        a.db.close();

        const b = open({ path });
        expect(migrate(b.db, MIGRATIONS).applied).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
        expect(
          b.db.get<Record<string, unknown>>(
            "SELECT id, email, role_id, disabled, created_at FROM users",
          ),
        ).toEqual({
          id: "u1",
          email: "ada@example.com",
          role_id: "member",
          disabled: 1,
          created_at: 42,
        });
        expect(b.db.query("PRAGMA foreign_key_check")).toEqual([]);
        expect(Number(b.db.pragma<any>("PRAGMA foreign_keys")!.foreign_keys)).toBe(1);

        // The children followed the rename: deleting the user still cascades to both.
        b.db.run("DELETE FROM users WHERE id = 'u1'");
        expect(b.db.query("SELECT id FROM sessions")).toEqual([]);
        expect(b.db.query("SELECT id FROM api_tokens")).toEqual([]);
        b.db.close();
      });
    });

    describe("0007 templates", () => {
      test("a fresh database has the built-in template at the old defaults, and nothing deletes it", () => {
        const { db } = fresh();
        migrate(db, MIGRATIONS);
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

      test("upgrades a populated 0006 database: the defaults.* settings become the default template; a repo at the old column default follows its template, a chosen clearance is kept", () => {
        const upTo6 = tempDir();
        for (const f of readdirSync(MIGRATIONS))
          if (/^000[1-6]_/.test(f)) copyFileSync(join(MIGRATIONS, f), join(upTo6, f));
        const path = join(tempDir(), "g.db");
        const a = open({ path });
        expect(migrate(a.db, upTo6).applied).toEqual([1, 2, 3, 4, 5, 6]);
        a.db.run(
          "INSERT INTO settings (key, value_json, updated_at) VALUES ('defaults.ttl', '\"3d\"', 1), ('defaults.visibility', '\"private\"', 1), ('secrets.defaultClearance', '\"low\"', 1), ('baseDomain', '\"x.test\"', 1)",
        );
        a.db.run(
          "INSERT INTO repos (id, forge, full_name, slug, pr_clearance, fork_clearance, visibility, env_ciphertext, created_at, updated_at) VALUES ('r1', 'github', 'acme/a', 'a', 'standard', 'none', 'public', 'sealed', 1, 1), ('r2', 'github', 'acme/b', 'b', 'high', 'low', NULL, NULL, 1, 1)",
        );
        a.db.close();

        const upTo7 = tempDir();
        for (const f of readdirSync(MIGRATIONS))
          if (/^000[1-7]_/.test(f)) copyFileSync(join(MIGRATIONS, f), join(upTo7, f));
        const b = open({ path });
        expect(migrate(b.db, upTo7).applied).toEqual([7]);
        expect(
          b.db.get<Record<string, unknown>>(
            "SELECT visibility, ttl, idle_after, clearance FROM templates WHERE id = 'default'",
          ),
        ).toEqual({ visibility: "private", ttl: "3d", idle_after: "30m", clearance: "low" });
        expect(
          b.db.query<{ key: string }>("SELECT key FROM settings ORDER BY key").map((r) => r.key),
        ).toEqual(["baseDomain"]);
        expect(
          b.db.query<Record<string, unknown>>(
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
        expect(b.db.query("PRAGMA foreign_key_check")).toEqual([]);
        // A deleted template leaves its repositories on the trigger default.
        b.db.run(
          "INSERT INTO templates (id, name, visibility, created_at, updated_at) VALUES ('staging', 'Staging', 'public', 1, 1)",
        );
        b.db.run("UPDATE repos SET template_id = 'staging' WHERE id = 'r1'");
        expect(() => b.db.run("UPDATE repos SET template_id = 'ghost' WHERE id = 'r2'")).toThrow();
        b.db.run("DELETE FROM templates WHERE id = 'staging'");
        expect(
          b.db.get<{ template_id: string | null }>("SELECT template_id FROM repos WHERE id = 'r1'")!
            .template_id,
        ).toBeNull();
        b.db.close();
      });
    });

    describe("0010 preview owner", () => {
      test("every role that could deploy -- a custom one too -- can still mint a deploy token: it gets previews.update_own; old previews own nothing", () => {
        const upTo9 = tempDir();
        for (const f of readdirSync(MIGRATIONS))
          if (/^000[1-9]_/.test(f)) copyFileSync(join(MIGRATIONS, f), join(upTo9, f));
        const path = join(tempDir(), "g.db");
        const a = open({ path });
        migrate(a.db, upTo9);
        a.db.run(
          "INSERT INTO roles (id, name, description, builtin, created_at) VALUES ('ci', 'ci', 'CI only', 0, 1), ('auditor', 'auditor', 'looks', 0, 1)",
        );
        a.db.run(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES ('ci', 'previews.deploy'), ('auditor', 'previews.read')",
        );
        a.db.run(
          "INSERT INTO hosts (id, name, docker_host, capabilities, publish_bind, upstream_dial, upstream_address, port_range_start, port_range_end, created_at) VALUES ('local', 'local', 'unix:///x', '[\"preview\"]', '127.0.0.1', 'direct', '127.0.0.1', 31000, 31099, 1)",
        );
        a.db.run(
          "INSERT INTO previews (id, project, host_id, state, source_kind, source_json, visibility, created_at, updated_at) VALUES ('p1', 'gw-t-x', 'local', 'awake', 'image', '{\"image\":\"x\"}', 'public', 1, 1)",
        );
        a.db.close();

        const b = open({ path });
        expect(migrate(b.db, MIGRATIONS).applied).toEqual([10, 11, 12, 13]);
        const holders = b.db
          .query<{ role_id: string }>(
            "SELECT role_id FROM role_permissions WHERE permission_id = 'previews.update_own' ORDER BY role_id",
          )
          .map((r) => r.role_id);
        expect(holders).toEqual(["admin", "ci", "member"]);
        expect(
          b.db.get<{ owner: string | null }>("SELECT owner FROM previews WHERE id = 'p1'")!.owner,
        ).toBeNull();
        expect(b.db.query("PRAGMA foreign_key_check")).toEqual([]);
        b.db.close();
      });
    });

    describe("0008 projects", () => {
      test("upgrades a populated 0007 database: each repository becomes a project named after it, still on the webhook; its PR previews are filed under it; its secrets come along", () => {
        const upTo7 = tempDir();
        for (const f of readdirSync(MIGRATIONS))
          if (/^000[1-7]_/.test(f)) copyFileSync(join(MIGRATIONS, f), join(upTo7, f));
        const path = join(tempDir(), "g.db");
        const a = open({ path });
        migrate(a.db, upTo7);
        a.db.run(
          "INSERT INTO hosts (id, name, docker_host, capabilities, publish_bind, upstream_dial, upstream_address, port_range_start, port_range_end, created_at) VALUES ('local', 'local', 'unix:///x', '[\"preview\"]', '127.0.0.1', 'direct', '127.0.0.1', 31000, 31099, 1)",
        );
        a.db.run(
          "INSERT INTO repos (id, forge, full_name, installation_id, slug, pr_clearance, fork_clearance, visibility, template_id, env_ciphertext, created_at, updated_at) VALUES ('r1', 'github', 'acme/store-admin', '42', 'store-admin', 'high', 'none', 'private', 'default', 'sealed', 1, 1)",
        );
        a.db.run(
          "INSERT INTO previews (id, project, host_id, state, source_kind, source_json, visibility, created_at, updated_at) VALUES ('p1', 'gw-t-store-admin-pr-4', 'local', 'awake', 'pr', '{\"repo\":\"acme/store-admin\",\"number\":4,\"sha\":\"a\"}', 'unlisted', 1, 1), ('p2', 'gw-t-whoami', 'local', 'awake', 'image', '{\"image\":\"x\"}', 'public', 1, 1)",
        );
        a.db.close();

        const b = open({ path });
        expect(migrate(b.db, MIGRATIONS).applied).toEqual([8, 9, 10, 11, 12, 13]);
        expect(
          b.db.get<Record<string, unknown>>(
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
          b.db.query<Record<string, unknown>>("SELECT id, project_id FROM previews ORDER BY id"),
        ).toEqual([
          { id: "p1", project_id: "r1" },
          { id: "p2", project_id: null },
        ]);
        expect(b.db.query("SELECT name FROM sqlite_master WHERE name = 'repos'")).toEqual([]);
        // A repository is both-or-neither.
        expect(() =>
          b.db.run(
            "INSERT INTO projects (id, name, slug, forge, created_at, updated_at) VALUES ('x', 'x', 'x', 'github', 1, 1)",
          ),
        ).toThrow();
        b.db.run(
          "INSERT INTO projects (id, name, slug, created_at, updated_at) VALUES ('y', 'whoami', 'whoami', 1, 1)",
        );
        expect(b.db.query("PRAGMA foreign_key_check")).toEqual([]);
        b.db.close();
      });
    });
  });
}

describe("migration loader", () => {
  const withFiles = (files: Record<string, string>) => {
    const d = join(tempDir(), "m");
    mkdirSync(d, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
    return d;
  };

  test("orders numerically, not lexically, past 0009", () => {
    const d = withFiles({
      "0009_nine.sql": "CREATE TABLE t9 (a);",
      "0010_ten.sql": "CREATE TABLE t10 (a);",
      "0002_two.sql": "CREATE TABLE t2 (a);",
    });
    expect(loadMigrations(d).map((m) => m.version)).toEqual([2, 9, 10]);
  });

  test("rejects a malformed filename", () => {
    expect(() => loadMigrations(withFiles({ "init.sql": "" }))).toThrow(/NNNN_lower_snake/);
  });

  test("rejects a duplicate version", () => {
    expect(() => loadMigrations(withFiles({ "0001_a.sql": "", "0001_b.sql": "" }))).toThrow(
      /duplicate/,
    );
  });

  test("rejects a migration that sets journal_mode", () => {
    expect(() => loadMigrations(withFiles({ "0001_x.sql": "PRAGMA journal_mode = WAL;" }))).toThrow(
      /journal_mode/,
    );
  });
});

describe("migration safety", () => {
  const open2 = (p: string) => openBun({ path: p }).db;
  const withFiles = (files: Record<string, string>) => {
    const d = join(tempDir(), "m");
    mkdirSync(d, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
    return d;
  };

  test("detects checksum drift on an already-applied migration", () => {
    const dir = tempDir();
    const dbPath = join(dir, "g.db");
    const m1 = withFiles({ "0001_a.sql": "CREATE TABLE t (a);" });
    const db1 = open2(dbPath);
    migrate(db1, m1);
    db1.close();

    writeFileSync(join(m1, "0001_a.sql"), "CREATE TABLE t (a, b);"); // edited after the fact
    const db2 = open2(dbPath);
    expect(() => migrate(db2, m1)).toThrow(/has changed since it was applied/);
    db2.close();
  });

  test("refuses to run when the database is ahead of the build", () => {
    const dir = tempDir();
    const dbPath = join(dir, "g.db");
    const full = withFiles({
      "0001_a.sql": "CREATE TABLE t (a);",
      "0002_b.sql": "CREATE TABLE u (a);",
    });
    const db1 = open2(dbPath);
    migrate(db1, full);
    db1.close();

    const older = withFiles({ "0001_a.sql": "CREATE TABLE t (a);" });
    const db2 = open2(dbPath);
    expect(() => migrate(db2, older)).toThrow(/older than the database/);
    db2.close();
  });

  test("a failing migration leaves no partial schema and is retried next boot", () => {
    const dir = tempDir();
    const dbPath = join(dir, "g.db");
    const broken = withFiles({ "0001_a.sql": "CREATE TABLE ok (a); CREATE TABLE ok (a);" }); // duplicate table
    const db1 = open2(dbPath);
    expect(() => migrate(db1, broken)).toThrow();
    expect(db1.query("SELECT name FROM sqlite_master WHERE name = 'ok'")).toHaveLength(0);
    expect(db1.query("SELECT * FROM schema_migrations")).toHaveLength(0);
    db1.close();
  });

  test("applies pending migrations in order and records them", () => {
    const dir = tempDir();
    const db = open2(join(dir, "g.db"));
    const m = withFiles({
      "0001_a.sql": "CREATE TABLE a (x);",
      "0002_b.sql": "CREATE TABLE b (x);",
    });
    expect(migrate(db, m).applied).toEqual([1, 2]);
    const rows = db.query<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    expect(rows).toEqual([
      { version: 1, name: "a" },
      { version: 2, name: "b" },
    ]);
    db.close();
  });

  test("checksum is stable and content-sensitive", () => {
    expect(checksum("a")).toBe(checksum("a"));
    expect(checksum("a")).not.toBe(checksum("b"));
  });
});
