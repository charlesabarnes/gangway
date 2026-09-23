import type { AuditActorType, AuditEntry } from "@gangway/shared/domain";
import type { Db } from "../types.ts";
import { rowToAuditEntry, type AuditRow } from "./mappers.ts";

export type AppendAudit = {
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  target: string | null;
  old?: unknown;
  new?: unknown;
};

export class AuditRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  append(e: AppendAudit): number {
    const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
    return this.#db.run(
      `INSERT INTO audit (actor_type, actor_id, action, target, old_json, new_json, created_at)
       VALUES ($type, $id, $action, $target, $old, $new, $now)`,
      {
        type: e.actorType,
        id: e.actorId,
        action: e.action,
        target: e.target,
        old: json(e.old),
        new: json(e.new),
        now: this.#now(),
      },
    ).lastInsertRowid;
  }

  page(q: { before?: number; limit: number; action?: string }): {
    entries: AuditEntry[];
    nextBefore: number | null;
  } {
    const rows = this.#db.query<AuditRow>(
      `SELECT * FROM audit
        WHERE seq < $before AND ($action IS NULL OR action = $action)
        ORDER BY seq DESC LIMIT $limit`,
      { before: q.before ?? Number.MAX_SAFE_INTEGER, action: q.action ?? null, limit: q.limit + 1 },
    );
    const entries = rows.slice(0, q.limit).map(rowToAuditEntry);
    return { entries, nextBefore: rows.length > q.limit ? entries[entries.length - 1]!.seq : null };
  }
}
