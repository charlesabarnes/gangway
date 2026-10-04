import { must } from "@gangway/shared/must";
import type { GangwayEvent } from "@gangway/shared/domain";
import { orgScope } from "../../tenancy/scope.ts";
import type { Db } from "../types.ts";
import { rowToEvent, type EventRow } from "./mappers.ts";

export class EventsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  append(
    type: string,
    payload: Record<string, unknown> = {},
    previewId: string | null = null,
  ): GangwayEvent {
    const s = orgScope();
    const r = this.#db.run(
      `INSERT INTO events (preview_id, org_id, type, payload_json, created_at)
       VALUES ($p, COALESCE((SELECT org_id FROM previews WHERE id = $p), $org), $type, $payload, $now)`,
      {
        p: previewId,
        org: s === "fleet" ? null : s.org,
        type,
        payload: JSON.stringify(payload),
        now: this.#now(),
      },
    );
    const row = this.#db.get("SELECT * FROM events WHERE seq = $s", {
      s: r.lastInsertRowid,
    }) as EventRow | undefined;
    return rowToEvent(must(row, "the event just appended"));
  }

  /** After `afterSeq`, as `org` may see them: its own, and the server's own for the home org. */
  since(
    afterSeq: number,
    limit = 200,
    previewId?: string,
    org: string | null = null,
  ): GangwayEvent[] {
    return (
      this.#db.query(
        `SELECT * FROM events
          WHERE seq > $seq AND ($p IS NULL OR preview_id = $p)
            AND ($org IS NULL OR org_id = $org
                 OR (org_id IS NULL AND $org = (SELECT id FROM orgs WHERE home = 1)))
          ORDER BY seq LIMIT $limit`,
        { seq: afterSeq, p: previewId ?? null, org, limit },
      ) as EventRow[]
    ).map(rowToEvent);
  }

  latestSeq(): number {
    return (
      (this.#db.get("SELECT MAX(seq) AS s FROM events") as { s: number | null } | undefined)?.s ?? 0
    );
  }

  forPreview(previewId: string, limit = 200): GangwayEvent[] {
    return (
      this.#db.query("SELECT * FROM events WHERE preview_id = $p ORDER BY seq DESC LIMIT $limit", {
        p: previewId,
        limit,
      }) as EventRow[]
    )
      .map(rowToEvent)
      .reverse();
  }

  pruneBefore(cutoff: number): number {
    return this.#db.run("DELETE FROM events WHERE created_at < $c", { c: cutoff }).changes;
  }
}
