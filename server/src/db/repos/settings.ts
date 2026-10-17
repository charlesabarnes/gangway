import type { SettingsStore } from "../../settings.ts";
import type { OrgSettingsStore } from "../../settings-org.ts";
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
    if (this.#rows) {
      return this.#rows;
    }
    const rows = new Map<string, unknown>();
    for (const r of this.#db.query("SELECT key, value_json FROM settings") as {
      key: string;
      value_json: string;
    }[]) {
      try {
        rows.set(r.key, JSON.parse(r.value_json));
      } catch {}
    }
    this.#rows = rows;
    return rows;
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

export class SqliteOrgSettingsStore implements OrgSettingsStore {
  readonly #db: Db;
  readonly #now: () => number;
  #rows: Map<string, unknown> | null = null;
  #version = 0;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  get(org: string, key: string): unknown {
    return this.#load().get(`${org}\n${key}`);
  }

  version(): number {
    return this.#version;
  }

  #load(): Map<string, unknown> {
    if (this.#rows) {
      return this.#rows;
    }
    const rows = new Map<string, unknown>();
    for (const r of this.#db.query("SELECT org_id, key, value_json FROM org_settings") as {
      org_id: string;
      key: string;
      value_json: string;
    }[]) {
      try {
        rows.set(`${r.org_id}\n${r.key}`, JSON.parse(r.value_json));
      } catch {}
    }
    this.#rows = rows;
    return rows;
  }

  #changed(): void {
    this.#rows = null;
    this.#version++;
  }

  set(org: string, key: string, value: unknown): void {
    this.#db.run(
      `INSERT INTO org_settings (org_id, key, value_json, updated_at) VALUES ($org, $key, $v, $now)
       ON CONFLICT(org_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      { org, key, v: JSON.stringify(value ?? null), now: this.#now() },
    );
    this.#changed();
  }

  delete(org: string, key: string): void {
    this.#db.run("DELETE FROM org_settings WHERE org_id = $org AND key = $key", { org, key });
    this.#changed();
  }
}
