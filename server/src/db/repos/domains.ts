import { must } from "@gangway/shared/must";
import type { Domain, DomainKind, DomainStatus } from "@gangway/shared/domain";
import type { Db } from "../types.ts";
import { rowToDomain, type DomainRow } from "./mappers.ts";

export type CreateDomain = {
  id: string;
  name: string;
  kind: DomainKind;
  projectId?: string | null | undefined;
  previewId?: string | null | undefined;
  claimId: string;
  createdBy?: string | null | undefined;
};

export type DomainCheck = {
  status: DomainStatus;
  routingOk: boolean;
  lastError: string | null;
};

export class DomainsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(d: CreateDomain): Domain {
    const now = this.#now();
    this.#db.run(
      `INSERT INTO domains (id, name, kind, project_id, preview_id, claim_id, created_by, created_at, updated_at)
       VALUES ($id, $name, $kind, $projectId, $previewId, $claimId, $createdBy, $now, $now)`,
      {
        id: d.id,
        name: d.name,
        kind: d.kind,
        projectId: d.projectId ?? null,
        previewId: d.previewId ?? null,
        claimId: d.claimId,
        createdBy: d.createdBy ?? null,
        now,
      },
    );
    return must(this.get(d.id), "the domain just saved");
  }

  get(id: string): Domain | undefined {
    const r = this.#db.get("SELECT * FROM domains WHERE id = $id", { id }) as DomainRow | undefined;
    return r ? rowToDomain(r) : undefined;
  }

  byName(name: string): Domain | undefined {
    const r = this.#db.get("SELECT * FROM domains WHERE name = $name", { name }) as
      DomainRow | undefined;
    return r ? rowToDomain(r) : undefined;
  }

  all(): Domain[] {
    return (this.#db.query("SELECT * FROM domains ORDER BY name") as DomainRow[]).map(rowToDomain);
  }

  forProject(projectId: string): Domain[] {
    return (
      this.#db.query("SELECT * FROM domains WHERE project_id = $p ORDER BY name", {
        p: projectId,
      }) as DomainRow[]
    ).map(rowToDomain);
  }

  forPreview(previewId: string): Domain[] {
    return (
      this.#db.query("SELECT * FROM domains WHERE preview_id = $p ORDER BY name", {
        p: previewId,
      }) as DomainRow[]
    ).map(rowToDomain);
  }

  pending(): Domain[] {
    return (
      this.#db.query(
        "SELECT * FROM domains WHERE status = 'pending' ORDER BY created_at",
      ) as DomainRow[]
    ).map(rowToDomain);
  }

  /** A check's outcome. Becoming active stamps verified_at once. */
  recordCheck(id: string, c: DomainCheck): void {
    const now = this.#now();
    this.#db.run(
      `UPDATE domains SET status = $status, routing_ok = $routing, last_error = $error,
         checked_at = $now, updated_at = $now,
         verified_at = CASE WHEN $status = 'active' THEN COALESCE(verified_at, $now) ELSE verified_at END
       WHERE id = $id`,
      { id, status: c.status, routing: c.routingOk ? 1 : 0, error: c.lastError, now },
    );
  }

  /** Back to pending, its patience counted again from `at`, for a claim tried again. */
  retry(id: string, at: number = this.#now()): void {
    this.#db.run(
      "UPDATE domains SET status = 'pending', last_error = NULL, created_at = $at, updated_at = $at WHERE id = $id",
      { id, at },
    );
  }

  delete(id: string): void {
    this.#db.run("DELETE FROM domains WHERE id = $id", { id });
  }

  /** A destroyed preview's own hostnames go, and no project's production points at it. */
  releasePreview(previewId: string): boolean {
    return this.#db.transaction(() => {
      const claims = this.#db.run("DELETE FROM domains WHERE preview_id = $p", { p: previewId });
      const pins = this.#db.run(
        "UPDATE projects SET production_preview_id = NULL, updated_at = $now WHERE production_preview_id = $p",
        { p: previewId, now: this.#now() },
      );
      return claims.changes + pins.changes > 0;
    });
  }
}
