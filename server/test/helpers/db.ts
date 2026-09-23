import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import type { Db, OpenOptions } from "../../src/db/types.ts";
import { onCleanup } from "./cleanup.ts";

export const MIGRATIONS = join(import.meta.dir, "../../migrations");

/** A fresh directory, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gangway-test-"));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A migrated SQLite in a fresh directory. `open` picks the driver; `now` stamps the migrations. */
export function tempDb(o: { open?: (o: OpenOptions) => { db: Db }; now?: () => number } = {}) {
  const dir = tempDir();
  const { db } = (o.open ?? openDatabase)({ path: join(dir, "g.db") });
  migrate(db, MIGRATIONS, o.now);
  return { db, dir };
}
