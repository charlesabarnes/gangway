import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compareVersion, type Db } from "../../src/db/types.ts";
import { migrate } from "../../src/db/migrate.ts";
import { MIGRATIONS, tempDir } from "../helpers/db.ts";
import { ALL_VERSIONS, DRIVERS } from "../helpers/db-migrations.ts";

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

const ROUTE = `INSERT INTO routes (hostname, preview_id, service, container_port, upstream_host, upstream_port, created_at)
               VALUES ($h, 'pv1', $service, $port, '127.0.0.1', $upstream, $now)`;

/** A migrated database with one host, one preview and one route on a.preview.test:31000. */
function seeded(db: Db) {
  migrate(db, MIGRATIONS);
  const now = Date.now();
  db.run(
    `INSERT INTO hosts (id, name, docker_host, created_at) VALUES ('local', 'local', 'unix:///x', $now)`,
    { now },
  );
  db.run(
    `INSERT INTO previews (id, project, host_id, state, source_kind, created_at, updated_at)
          VALUES ('pv1', 'gw-1', 'local', 'building', 'image', $now, $now)`,
    { now },
  );
  db.run(ROUTE, { h: "a.preview.test", service: "web", port: 3000, upstream: 31000, now });
  return now;
}

for (const [name, open] of DRIVERS) {
  describe(`driver ${name}`, () => {
    const fresh = () => open({ path: join(tempDir(), "g.db") });

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

    test("the real migrations all apply to a fresh database", () => {
      const { db } = fresh();
      expect(migrate(db, MIGRATIONS).applied).toEqual(ALL_VERSIONS);
      db.close();
    });

    test.each([
      [
        "a second route on the same hostname",
        (db: Db, now: number) =>
          db.run(ROUTE, { h: "a.preview.test", service: "api", port: 4000, upstream: 31001, now }),
      ],
      [
        "a host port claimed twice",
        (db: Db, now: number) =>
          db.run(ROUTE, { h: "b.preview.test", service: "api", port: 4000, upstream: 31000, now }),
      ],
      [
        "an illegal preview state",
        (db: Db, now: number) =>
          db.run(
            `INSERT INTO previews (id, project, host_id, state, source_kind, created_at, updated_at)
                  VALUES ('x','gw-x','local','banana','image',$now,$now)`,
            { now },
          ),
      ],
      [
        "malformed source JSON",
        (db: Db, now: number) =>
          db.run(
            `INSERT INTO previews (id, project, host_id, state, source_kind, source_json, created_at, updated_at)
                  VALUES ('y','gw-y','local','building','image','{oops',$now,$now)`,
            { now },
          ),
      ],
    ])("the schema rejects %s", (_what, write) => {
      const { db } = fresh();
      const now = seeded(db);
      expect(() => write(db, now)).toThrow();
      db.close();
    });

    test("destroying a preview cascades its routes away", () => {
      const { db } = fresh();
      seeded(db);
      db.run("DELETE FROM previews WHERE id = 'pv1'");
      expect(db.query("SELECT * FROM routes")).toHaveLength(0);
      db.close();
    });

    test("migrate is idempotent across reopen", () => {
      const dir = tempDir();
      const a = open({ path: join(dir, "g.db") });
      expect(migrate(a.db, MIGRATIONS).applied).toEqual(ALL_VERSIONS);
      a.db.close();
      const b = open({ path: join(dir, "g.db") });
      const r = migrate(b.db, MIGRATIONS);
      expect(r.applied).toEqual([]);
      expect(r.alreadyApplied).toEqual(ALL_VERSIONS);
      b.db.close();
    });
  });
}
