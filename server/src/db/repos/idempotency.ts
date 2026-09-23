import type { Db } from "../types.ts";

export type IdempotencyRecord = {
  key: string;
  ownerId: string;
  previewId: string | null;
  requestHash: string;
  createdAt: number;
};

type Row = {
  key: string;
  token_id: string;
  preview_id: string | null;
  request_hash: string;
  created_at: number;
};

/**
 * Which preview a caller-supplied Idempotency-Key already produced. Scoped per principal
 * (`actorId`: a token id or `user:<id>`) -- one agent's retry must not collide with
 * another's key. The column is called `token_id` but holds any actor id. `response_json`
 * is deliberately left NULL: a replay answers with the preview as it is now.
 */
export class IdempotencyRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  get(key: string, ownerId: string): IdempotencyRecord | undefined {
    const r = this.#db.get<Row>(
      "SELECT key, token_id, preview_id, request_hash, created_at FROM idempotency_keys WHERE key = $key AND token_id = $t",
      { key, t: ownerId },
    );
    return r
      ? {
          key: r.key,
          ownerId: r.token_id,
          previewId: r.preview_id,
          requestHash: r.request_hash,
          createdAt: r.created_at,
        }
      : undefined;
  }

  /** Upsert: a key whose preview is gone is free to mean something new. */
  put(r: { key: string; ownerId: string; previewId: string; requestHash: string }): void {
    this.#db.run(
      `INSERT INTO idempotency_keys (key, token_id, preview_id, request_hash, created_at)
       VALUES ($key, $t, $p, $h, $now)
       ON CONFLICT(key, token_id) DO UPDATE SET
         preview_id = excluded.preview_id, request_hash = excluded.request_hash, created_at = excluded.created_at`,
      { key: r.key, t: r.ownerId, p: r.previewId, h: r.requestHash, now: this.#now() },
    );
  }

  purge(before: number): number {
    return this.#db.run("DELETE FROM idempotency_keys WHERE created_at < $before", { before })
      .changes;
  }
}
