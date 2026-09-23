import type { SettingsStore } from "../../settings.ts";
import type { Db } from "../types.ts";

/** The database half of the §10.5 precedence rule. Config overrides sit above this. */
export class SqliteSettingsStore implements SettingsStore {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  get(key: string): unknown | undefined {
    const r = this.#db.get<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = $key",
      { key },
    );
    if (!r) return undefined;
    try {
      return JSON.parse(r.value_json);
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.#db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ($key, $v, $now)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      { key, v: JSON.stringify(value ?? null), now: this.#now() },
    );
  }

  all(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.#db.query<{ key: string; value_json: string }>(
      "SELECT key, value_json FROM settings",
    )) {
      try {
        out[r.key] = JSON.parse(r.value_json);
      } catch {
        /* skip a corrupt row */
      }
    }
    return out;
  }

  delete(key: string): void {
    this.#db.run("DELETE FROM settings WHERE key = $key", { key });
  }
}
