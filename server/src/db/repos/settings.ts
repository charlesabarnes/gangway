import type { SettingsStore } from "../../settings.ts";
import type { Db } from "../types.ts";

export class SqliteSettingsStore implements SettingsStore {
  readonly #db: Db;
  readonly #now: () => number;
  // One process owns the database, so the rows read once stay true until this store writes.
  #rows: Map<string, unknown> | null = null;
  #version = 0;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  get(key: string): unknown {
    return this.#load().get(key);
  }

  version(): number {
    return this.#version;
  }

  #load(): Map<string, unknown> {
    if (this.#rows) return this.#rows;
    const rows = new Map<string, unknown>();
    for (const r of this.#db.query<{ key: string; value_json: string }>(
      "SELECT key, value_json FROM settings",
    )) {
      try {
        rows.set(r.key, JSON.parse(r.value_json));
      } catch {}
    }
    return (this.#rows = rows);
  }

  #changed(): void {
    this.#rows = null;
    this.#version++;
  }

  set(key: string, value: unknown): void {
    this.#db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ($key, $v, $now)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      { key, v: JSON.stringify(value ?? null), now: this.#now() },
    );
    this.#changed();
  }

  all(): Record<string, unknown> {
    return Object.fromEntries(this.#load());
  }

  delete(key: string): void {
    this.#db.run("DELETE FROM settings WHERE key = $key", { key });
    this.#changed();
  }
}
