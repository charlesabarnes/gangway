import { must } from "@gangway/shared/must";
import type { GangwayEvent } from "@gangway/shared/domain";
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
    const r = this.#db.run(
      `INSERT INTO events (preview_id, type, payload_json, created_at)
       VALUES ($p, $type, $payload, $now)`,
      { p: previewId, type, payload: JSON.stringify(payload), now: this.#now() },
    );
    const row = this.#db.get("SELECT * FROM events WHERE seq = $s", {
      s: r.lastInsertRowid,
    }) as EventRow | undefined;
    return rowToEvent(must(row, "the event just appended"));
  }

  since(afterSeq: number, limit = 200, previewId?: string): GangwayEvent[] {
    const sql = previewId
      ? `SELECT * FROM events WHERE seq > $seq AND preview_id = $p ORDER BY seq LIMIT $limit`
      : `SELECT * FROM events WHERE seq > $seq ORDER BY seq LIMIT $limit`;
    const params = previewId ? { seq: afterSeq, p: previewId, limit } : { seq: afterSeq, limit };
    return (this.#db.query(sql, params) as EventRow[]).map(rowToEvent);
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
