import type { Db } from "../types.ts";

export type BuildState = "running" | "succeeded" | "failed" | "cancelled";

export type Build = {
  id: string;
  previewId: string;
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

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

function monthSpans(start: number, to: number): [string, number][] {
  const spans: [string, number][] = [];
  for (let from = start; from < to;) {
    const d = new Date(from);
    const end = Math.min(to, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    spans.push([monthOf(from), end - from]);
    from = end;
  }
  return spans;
}

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
    const now = this.#now();
    this.#db.transaction(() => {
      const ended = this.#db.run(
        "UPDATE builds SET state = $state, finished_at = $now, exit_code = $code WHERE id = $id AND state = 'running'",
        { id, state, code: exitCode, now },
      ).changes;
      const row = this.#db.query(
        "SELECT p.org_id, b.started_at FROM builds b JOIN previews p ON p.id = b.preview_id WHERE b.id = $id",
        { id },
      )[0] as { org_id: string; started_at: number } | undefined;
      if (ended === 0 || !row) {
        return;
      }
      for (const [month, ms] of monthSpans(row.started_at, now)) {
        this.#db.run(
          `INSERT INTO org_build_usage (org_id, month, build_ms) VALUES ($o, $month, $ms)
           ON CONFLICT (org_id, month) DO UPDATE SET build_ms = build_ms + excluded.build_ms`,
          { o: row.org_id, month, ms },
        );
      }
    });
  }

  /** The org's build time this calendar month, in ms; running builds not yet counted. */
  usedThisMonth(orgId: string): number {
    const row = this.#db.query(
      "SELECT build_ms FROM org_build_usage WHERE org_id = $o AND month = $m",
      { o: orgId, m: monthOf(this.#now()) },
    )[0] as { build_ms: number } | undefined;
    return row?.build_ms ?? 0;
  }

  forPreview(previewId: string): Build[] {
    return (
      this.#db.query(
        "SELECT id, preview_id, service, state, started_at, finished_at, exit_code FROM builds WHERE preview_id = $p ORDER BY started_at, id",
        { p: previewId },
      ) as Row[]
    ).map(toBuild);
  }

  cancelRunning(): number {
    return this.#db.run(
      "UPDATE builds SET state = 'cancelled', finished_at = $now WHERE state = 'running'",
      { now: this.#now() },
    ).changes;
  }
}
