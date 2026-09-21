import type { Preview, PreviewKind, PreviewSource, PreviewState, Visibility } from "../../../../shared/src/domain.ts";
import type { Db } from "../types.ts";
import { fromDate, rowToPreview, sourceToColumns, type PreviewRow } from "./mappers.ts";

export type CreatePreview = {
  id: string;
  project: string;
  hostId: string;
  kind?: PreviewKind;
  state: PreviewState;
  source: PreviewSource;
  visibility: Visibility;
  ttlExpiresAt?: Date | null;
};

export type PreviewFilter = {
  state?: PreviewState | PreviewState[];
  hostId?: string;
  kind?: PreviewKind;
  includeDestroyed?: boolean;
};

export class PreviewsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(p: CreatePreview): Preview {
    const now = this.#now();
    const { source_kind, source_json } = sourceToColumns(p.source);
    this.#db.run(
      `INSERT INTO previews (id, project, host_id, kind, state, source_kind, source_json,
                             visibility, ttl_expires_at, created_at, updated_at)
       VALUES ($id, $project, $host_id, $kind, $state, $source_kind, $source_json,
               $visibility, $ttl, $now, $now)`,
      {
        id: p.id, project: p.project, host_id: p.hostId, kind: p.kind ?? "preview",
        state: p.state, source_kind, source_json, visibility: p.visibility,
        ttl: fromDate(p.ttlExpiresAt ?? null), now,
      },
    );
    return this.get(p.id)!;
  }

  get(id: string): Preview | undefined {
    const r = this.#db.get<PreviewRow>("SELECT * FROM previews WHERE id = $id", { id });
    return r ? rowToPreview(r) : undefined;
  }

  getByProject(project: string): Preview | undefined {
    const r = this.#db.get<PreviewRow>("SELECT * FROM previews WHERE project = $p", { p: project });
    return r ? rowToPreview(r) : undefined;
  }

  list(f: PreviewFilter = {}): Preview[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (f.state) {
      const states = Array.isArray(f.state) ? f.state : [f.state];
      where.push(`state IN (${states.map((_, i) => `$s${i}`).join(", ")})`);
      states.forEach((s, i) => { params[`s${i}`] = s; });
    }
    if (f.hostId) { where.push("host_id = $hostId"); params["hostId"] = f.hostId; }
    if (f.kind) { where.push("kind = $kind"); params["kind"] = f.kind; }
    if (!f.includeDestroyed && !f.state) where.push("state != 'destroyed'");

    const sql = `SELECT * FROM previews${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
    return this.#db.query<PreviewRow>(sql, Object.keys(params).length ? params : undefined).map(rowToPreview);
  }

  setState(id: string, state: PreviewState, error: string | null = null): void {
    this.#db.run(
      `UPDATE previews SET state = $state, error = $error, updated_at = $now,
         destroyed_at = CASE WHEN $state = 'destroyed' THEN $now ELSE destroyed_at END
       WHERE id = $id`,
      { id, state, error, now: this.#now() },
    );
  }

  /**
   * Written on every proxied request, so it must be as cheap as possible and must never
   * bump updated_at -- that column means "the lifecycle changed", not "someone visited".
   */
  touch(id: string, at: number = this.#now()): void {
    this.#db.run("UPDATE previews SET last_seen_at = $at WHERE id = $id", { id, at });
  }

  /** The batched form: one transaction for the whole flush. Never moves a timestamp backwards. */
  touchMany(seen: ReadonlyMap<string, number>): number {
    if (seen.size === 0) return 0;
    return this.#db.transaction(() => {
      let n = 0;
      for (const [id, at] of seen) {
        n += this.#db.run(
          "UPDATE previews SET last_seen_at = $at WHERE id = $id AND COALESCE(last_seen_at, 0) < $at", { id, at },
        ).changes;
      }
      return n;
    });
  }

  /** TTL sweeper (Phase 3). Destroyed previews are already gone and never re-expire. */
  expired(now: number = this.#now()): Preview[] {
    return this.#db.query<PreviewRow>(
      `SELECT * FROM previews
       WHERE ttl_expires_at IS NOT NULL AND ttl_expires_at <= $now
         AND state NOT IN ('destroyed', 'destroying')
       ORDER BY ttl_expires_at`,
      { now },
    ).map(rowToPreview);
  }

  /** Idle-sleep sweeper (Phase 4): awake previews untouched since the cutoff. */
  idleSince(cutoff: number): Preview[] {
    return this.#db.query<PreviewRow>(
      `SELECT * FROM previews
       WHERE state = 'awake' AND kind = 'preview'
         AND COALESCE(last_seen_at, created_at) <= $cutoff`,
      { cutoff },
    ).map(rowToPreview);
  }

  delete(id: string): boolean {
    return this.#db.run("DELETE FROM previews WHERE id = $id", { id }).changes > 0;
  }
}
