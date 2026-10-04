import type { AuditActorType, AuditEntry } from "@gangway/shared/domain";
import { orgScope } from "../../tenancy/scope.ts";
import type { Db } from "../types.ts";
import { rowToAuditEntry, type AuditRow } from "./mappers.ts";

export type AppendAudit = {
  actorType: AuditActorType;
  actorId: string | null;
  actorName?: string | null;
  action: string;
  target: string | null;
  /** null: the server's own, read only by the home org. */
  orgId: string | null;
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
      `INSERT INTO audit (actor_type, actor_id, actor_name, action, target, org_id, old_json, new_json, created_at)
       VALUES ($type, $id, $name, $action, $target, $org, $old, $new, $now)`,
      {
        type: e.actorType,
        id: e.actorId,
        name: e.actorName ?? null,
        action: e.action,
        target: e.target,
        org: e.orgId,
        old: json(e.old),
        new: json(e.new),
        now: this.#now(),
      },
    ).lastInsertRowid;
  }

  pruneBefore(cutoff: number): number {
    return this.#db.run("DELETE FROM audit WHERE created_at < $c", { c: cutoff }).changes;
  }

  page(q: { before?: number; limit: number; action?: string }): {
    entries: AuditEntry[];
    nextBefore: number | null;
  } {
    const s = orgScope();
    const rows = this.#db.query(
      `SELECT * FROM audit
        WHERE seq < $before AND ($action IS NULL OR action = $action)
          AND ($org IS NULL OR org_id = $org
               OR (org_id IS NULL AND $org = (SELECT id FROM orgs WHERE home = 1)))
        ORDER BY seq DESC LIMIT $limit`,
      {
        before: q.before ?? Number.MAX_SAFE_INTEGER,
        action: q.action ?? null,
        limit: q.limit + 1,
        org: s === "fleet" ? null : s.org,
      },
    ) as AuditRow[];
    const entries = rows.slice(0, q.limit).map(rowToAuditEntry);
    const last = entries.at(-1);
    return { entries, nextBefore: rows.length > q.limit && last ? last.seq : null };
  }
}
