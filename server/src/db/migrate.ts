import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./types.ts";

export type Migration = { version: number; name: string; sql: string; checksum: string };
export type AppliedRow = { version: number; name: string; checksum: string; applied_at: number };

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function checksum(sql: string): string {
  return new Bun.CryptoHasher("sha256").update(sql).digest("hex");
}

export function loadMigrations(dir: string): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`migration filename "${file}" must match NNNN_lower_snake.sql`);
    const sql = readFileSync(join(dir, file), "utf8");
    if (/PRAGMA\s+journal_mode/i.test(sql)) {
      throw new Error(
        `migration ${file} sets journal_mode; that belongs in the open sequence, not a migration`,
      );
    }
    out.push({ version: Number.parseInt(m[1]!, 10), name: m[2]!, sql, checksum: checksum(sql) });
  }
  // Numeric, not lexical: 0010 must follow 0009.
  out.sort((a, b) => a.version - b.version);

  for (let i = 0; i < out.length; i++) {
    const prev = out[i - 1];
    if (prev && prev.version === out[i]!.version) {
      throw new Error(`duplicate migration version ${out[i]!.version}`);
    }
  }
  return out;
}

function ensureTable(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
}

export type MigrateResult = { applied: number[]; alreadyApplied: number[]; journalMode?: string };

export function migrate(db: Db, dir: string, now: () => number = Date.now): MigrateResult {
  ensureTable(db);
  const migrations = loadMigrations(dir);
  const applied = db.query<AppliedRow>(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
  );
  const byVersion = new Map(applied.map((r) => [r.version, r]));

  for (const row of applied) {
    const file = migrations.find((m) => m.version === row.version);
    if (!file) {
      throw new Error(
        `database has migration ${row.version} (${row.name}) applied but no such file exists; ` +
          `this build is older than the database. Refusing to run.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new Error(
        `migration ${String(row.version).padStart(4, "0")}_${row.name}.sql has changed since it was applied ` +
          `(recorded ${row.checksum.slice(0, 12)}, file ${file.checksum.slice(0, 12)}). ` +
          `Edit a new migration instead.`,
      );
    }
  }

  const pending = migrations.filter((m) => !byVersion.has(m.version));
  const appliedNow: number[] = [];

  for (const m of pending) {
    // SQLite requires foreign_keys OFF around the table-rebuild pattern.
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(m.sql);
        db.run(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($version, $name, $checksum, $applied_at)",
          { version: m.version, name: m.name, checksum: m.checksum, applied_at: now() },
        );
        const violations = db.query<Record<string, unknown>>("PRAGMA foreign_key_check");
        if (violations.length > 0) {
          throw new Error(
            `migration ${m.version} left ${violations.length} foreign key violation(s)`,
          );
        }
      });
      appliedNow.push(m.version);
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }

  return { applied: appliedNow, alreadyApplied: [...byVersion.keys()] };
}
