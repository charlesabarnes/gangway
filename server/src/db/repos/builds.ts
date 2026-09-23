import type { Db } from "../types.ts";

export type BuildState = "running" | "succeeded" | "failed" | "cancelled";

export type Build = {
  id: string;
  previewId: string;
  /** The services built, comma-joined: one `compose build` builds them together. */
  service: string | null;
  state: BuildState;
  startedAt: Date;
  finishedAt: Date | null;
  exitCode: number | null;
};

type Row = {
  id: string;
  preview_id: string;
  service: string | null;
  state: BuildState;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
};

const toBuild = (r: Row): Build => ({
  id: r.id,
  previewId: r.preview_id,
  service: r.service,
  state: r.state,
  startedAt: new Date(r.started_at),
  finishedAt: r.finished_at === null ? null : new Date(r.finished_at),
  exitCode: r.exit_code,
});

/**
 * One row per build attempt. The build's OUTPUT is in the preview log (stream `build`),
 * which is already durable and resumable over SSE; this records that it happened, how
 * long it took and how it ended -- what the UI's history and "why is this slow" need.
 */
export class BuildsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  start(b: { id: string; previewId: string; services: string[] }): void {
    this.#db.run(
      "INSERT INTO builds (id, preview_id, service, state, started_at) VALUES ($id, $p, $s, 'running', $now)",
      { id: b.id, p: b.previewId, s: b.services.join(",") || null, now: this.#now() },
    );
  }

  finish(id: string, state: Exclude<BuildState, "running">, exitCode: number | null = null): void {
    this.#db.run(
      "UPDATE builds SET state = $state, finished_at = $now, exit_code = $code WHERE id = $id AND state = 'running'",
      { id, state, code: exitCode, now: this.#now() },
    );
  }

  forPreview(previewId: string): Build[] {
    return this.#db
      .query<Row>(
        "SELECT id, preview_id, service, state, started_at, finished_at, exit_code FROM builds WHERE preview_id = $p ORDER BY started_at, id",
        { p: previewId },
      )
      .map(toBuild);
  }

  /** Boot: a build cannot outlive the process that ran it. */
  cancelRunning(): number {
    return this.#db.run(
      "UPDATE builds SET state = 'cancelled', finished_at = $now WHERE state = 'running'",
      { now: this.#now() },
    ).changes;
  }
}
