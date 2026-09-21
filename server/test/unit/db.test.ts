import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase as openBun } from "../../src/db/sqlite.ts";
import { openDatabase as openNode } from "../../src/db/sqlite.node.ts";
import { compareVersion, type Db, type OpenOptions } from "../../src/db/types.ts";
import { checksum, loadMigrations, migrate } from "../../src/db/migrate.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "gangway-db-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const DRIVERS: [string, (o: OpenOptions) => { db: Db; journalMode: string }][] = [
  ["bun:sqlite", openBun],
  ["node:sqlite", openNode],
];

describe("compareVersion", () => {
  test.each([
    ["3.51.0", true], ["3.53.3", true], ["3.38.0", true],
    ["3.37.9", false], ["3.7.0", false], ["4.0.0", true],
  ])("%s meets the floor: %s", (v, want) => expect(compareVersion(v, [3, 38, 0])).toBe(want));
});

// The whole suite runs against BOTH drivers. That is the only thing that keeps the
// portability promise honest rather than aspirational.
for (const [name, open] of DRIVERS) {
  describe(`driver ${name}`, () => {
    const fresh = () => {
      const { db, journalMode } = open({ path: join(tmp(), "g.db") });
      return { db, journalMode };
    };

    test("opens with WAL and foreign keys enforced", () => {
      const { db, journalMode } = fresh();
      expect(journalMode).toBe("wal");
      expect(Number((db.pragma<any>("PRAGMA foreign_keys"))!.foreign_keys)).toBe(1);
      expect(compareVersion(db.sqliteVersion, [3, 38, 0])).toBe(true);
      db.close();
    });

    test("TRUNCATE is available as the FUSE fallback", () => {
      const { db, journalMode } = open({ path: join(tmp(), "g.db"), journalMode: "TRUNCATE" });
      expect(journalMode).toBe("truncate");
      db.close();
    });

    test("named parameters, query/get/run", () => {
      const { db } = fresh();
      db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
      const r = db.run("INSERT INTO t (id, n) VALUES ($id, $n)", { id: "a", n: 1 });
      expect(r.changes).toBe(1);
      db.run("INSERT INTO t (id, n) VALUES ($id, $n)", { id: "b", n: 2 });
      expect(db.query<{ id: string }>("SELECT id FROM t ORDER BY id")).toEqual([{ id: "a" }, { id: "b" }]);
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
      expect(() => db.run("INSERT INTO c (id, p_id) VALUES ($id, $p_id)", { id: "c2", p_id: "ghost" })).toThrow();
      db.run("DELETE FROM p WHERE id = $id", { id: "p1" });
      expect(db.query("SELECT * FROM c")).toHaveLength(0);
      db.close();
    });

    test("a transaction rolls back completely on throw", () => {
      const { db } = fresh();
      db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
      expect(() => db.transaction(() => {
        db.run("INSERT INTO t (id) VALUES ($id)", { id: "a" });
        throw new Error("boom");
      })).toThrow("boom");
      expect(db.query("SELECT * FROM t")).toHaveLength(0);
      db.close();
    });

    test("the real 0001 schema applies and enforces its constraints", () => {
      const { db } = fresh();
      const res = migrate(db, MIGRATIONS);
      expect(res.applied).toEqual([1, 2]);

      const now = Date.now();
      db.run(`INSERT INTO hosts (id, name, docker_host, created_at)
              VALUES ($id, $name, $dh, $now)`, { id: "local", name: "local", dh: "unix:///x", now });
      db.run(`INSERT INTO previews (id, project, host_id, state, source_kind, created_at, updated_at)
              VALUES ($id, $p, 'local', 'building', 'image', $now, $now)`, { id: "pv1", p: "gw-1", now });
      db.run(`INSERT INTO routes (hostname, preview_id, service, container_port, upstream_host, upstream_port, created_at)
              VALUES ($h, 'pv1', 'web', 3000, '127.0.0.1', 31000, $now)`, { h: "a.preview.test", now });

      // hostname is the primary key, so a collision is a constraint violation
      expect(() => db.run(`INSERT INTO routes (hostname, preview_id, service, container_port, upstream_host, upstream_port, created_at)
              VALUES ($h, 'pv1', 'api', 4000, '127.0.0.1', 31001, $now)`, { h: "a.preview.test", now })).toThrow();

      // and one host port may not be claimed twice
      expect(() => db.run(`INSERT INTO routes (hostname, preview_id, service, container_port, upstream_host, upstream_port, created_at)
              VALUES ($h, 'pv1', 'api', 4000, '127.0.0.1', 31000, $now)`, { h: "b.preview.test", now })).toThrow();

      // an illegal state is rejected by the CHECK, not silently stored
      expect(() => db.run(`INSERT INTO previews (id, project, host_id, state, source_kind, created_at, updated_at)
              VALUES ('x','gw-x','local','banana','image',$now,$now)`, { now })).toThrow();

      // malformed JSON is rejected by json_valid()
      expect(() => db.run(`INSERT INTO previews (id, project, host_id, state, source_kind, source_json, created_at, updated_at)
              VALUES ('y','gw-y','local','building','image','{oops',$now,$now)`, { now })).toThrow();

      // destroying a preview cascades its routes away
      db.run("DELETE FROM previews WHERE id = 'pv1'");
      expect(db.query("SELECT * FROM routes")).toHaveLength(0);
      db.close();
    });

    test("migrate is idempotent across reopen", () => {
      const dir = tmp();
      const a = open({ path: join(dir, "g.db") });
      expect(migrate(a.db, MIGRATIONS).applied).toEqual([1, 2]);
      a.db.close();
      const b = open({ path: join(dir, "g.db") });
      const r = migrate(b.db, MIGRATIONS);
      expect(r.applied).toEqual([]);
      expect(r.alreadyApplied).toEqual([1, 2]);
      b.db.close();
    });
  });
}

describe("migration loader", () => {
  const withFiles = (files: Record<string, string>) => {
    const d = join(tmp(), "m");
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
    expect(() => loadMigrations(withFiles({ "0001_a.sql": "", "0001_b.sql": "" }))).toThrow(/duplicate/);
  });

  test("rejects a migration that sets journal_mode", () => {
    expect(() => loadMigrations(withFiles({ "0001_x.sql": "PRAGMA journal_mode = WAL;" }))).toThrow(/journal_mode/);
  });
});

describe("migration safety", () => {
  const scratch = () => open2(join(tmp(), "g.db"));
  const open2 = (p: string) => openBun({ path: p }).db;
  const withFiles = (files: Record<string, string>) => {
    const d = join(tmp(), "m");
    mkdirSync(d, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
    return d;
  };

  test("detects checksum drift on an already-applied migration", () => {
    const dir = tmp();
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
    const dir = tmp();
    const dbPath = join(dir, "g.db");
    const full = withFiles({ "0001_a.sql": "CREATE TABLE t (a);", "0002_b.sql": "CREATE TABLE u (a);" });
    const db1 = open2(dbPath); migrate(db1, full); db1.close();

    const older = withFiles({ "0001_a.sql": "CREATE TABLE t (a);" });
    const db2 = open2(dbPath);
    expect(() => migrate(db2, older)).toThrow(/older than the database/);
    db2.close();
  });

  test("a failing migration leaves no partial schema and is retried next boot", () => {
    const dir = tmp();
    const dbPath = join(dir, "g.db");
    const broken = withFiles({ "0001_a.sql": "CREATE TABLE ok (a); CREATE TABLE ok (a);" }); // duplicate table
    const db1 = open2(dbPath);
    expect(() => migrate(db1, broken)).toThrow();
    expect(db1.query("SELECT name FROM sqlite_master WHERE name = 'ok'")).toHaveLength(0);
    expect(db1.query("SELECT * FROM schema_migrations")).toHaveLength(0);
    db1.close();
  });

  test("applies pending migrations in order and records them", () => {
    const dir = tmp();
    const db = open2(join(dir, "g.db"));
    const m = withFiles({ "0001_a.sql": "CREATE TABLE a (x);", "0002_b.sql": "CREATE TABLE b (x);" });
    expect(migrate(db, m).applied).toEqual([1, 2]);
    const rows = db.query<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version");
    expect(rows).toEqual([{ version: 1, name: "a" }, { version: 2, name: "b" }]);
    db.close();
  });

  test("checksum is stable and content-sensitive", () => {
    expect(checksum("a")).toBe(checksum("a"));
    expect(checksum("a")).not.toBe(checksum("b"));
  });
});
