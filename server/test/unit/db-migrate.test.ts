import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksum, loadMigrations, migrate } from "../../src/db/migrate.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { tempDir } from "../helpers/db.ts";
import { migrationFiles } from "../helpers/db-migrations.ts";

const openAt = (path: string) => openDatabase({ path }).db;

describe("migration loader", () => {
  test("orders numerically, not lexically, past 0009", () => {
    const d = migrationFiles({
      "0009_nine.sql": "CREATE TABLE t9 (a);",
      "0010_ten.sql": "CREATE TABLE t10 (a);",
      "0002_two.sql": "CREATE TABLE t2 (a);",
    });
    expect(loadMigrations(d).map((m) => m.version)).toEqual([2, 9, 10]);
  });

  test.each([
    ["a malformed filename", { "init.sql": "" }, /NNNN_lower_snake/],
    ["a duplicate version", { "0001_a.sql": "", "0001_b.sql": "" }, /duplicate/],
    [
      "a migration that sets journal_mode",
      { "0001_x.sql": "PRAGMA journal_mode = WAL;" },
      /journal_mode/,
    ],
  ])("rejects %s", (_what, files, error) => {
    expect(() => loadMigrations(migrationFiles(files))).toThrow(error);
  });
});

describe("migration safety", () => {
  test("detects checksum drift on an already-applied migration", () => {
    const dbPath = join(tempDir(), "g.db");
    const m1 = migrationFiles({ "0001_a.sql": "CREATE TABLE t (a);" });
    const db1 = openAt(dbPath);
    migrate(db1, m1);
    db1.close();

    writeFileSync(join(m1, "0001_a.sql"), "CREATE TABLE t (a, b);");
    const db2 = openAt(dbPath);
    expect(() => migrate(db2, m1)).toThrow(/has changed since it was applied/);
    db2.close();
  });

  test("refuses to run when the database is ahead of the build", () => {
    const dbPath = join(tempDir(), "g.db");
    const full = migrationFiles({
      "0001_a.sql": "CREATE TABLE t (a);",
      "0002_b.sql": "CREATE TABLE u (a);",
    });
    const db1 = openAt(dbPath);
    migrate(db1, full);
    db1.close();

    const older = migrationFiles({ "0001_a.sql": "CREATE TABLE t (a);" });
    const db2 = openAt(dbPath);
    expect(() => migrate(db2, older)).toThrow(/older than the database/);
    db2.close();
  });

  test("a failing migration leaves no partial schema and is retried next boot", () => {
    const db = openAt(join(tempDir(), "g.db"));
    const broken = migrationFiles({ "0001_a.sql": "CREATE TABLE ok (a); CREATE TABLE ok (a);" });
    expect(() => migrate(db, broken)).toThrow();
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'ok'")).toHaveLength(0);
    expect(db.query("SELECT * FROM schema_migrations")).toHaveLength(0);
    db.close();
  });

  test("applies pending migrations in order and records them", () => {
    const db = openAt(join(tempDir(), "g.db"));
    const m = migrationFiles({
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
