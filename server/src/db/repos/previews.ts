import type { Clearance, PasswordLogin, PasswordMode, Preview, PreviewKind, PreviewSource, PreviewState, Visibility } from "../../../../shared/src/domain.ts";
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
  idleAfterMs?: number | null;
  secretLevel?: Clearance | null;
  templateId?: string | null;
  projectId?: string | null;
  /** ADR-0021: who deployed it (`principalOf` in auth/actor.ts). Not on `Preview`: only `previews.update_own` asks. */
  owner?: string | null;
  /** ADR-0023. Omitted: inherit. */
  password?: StoredPreviewPassword;
  /** ADR-0023. Omitted: inherit. */
  passwordLogin?: PasswordLogin;
};

/** A preview's password as the database holds it: the mode, and the scrypt hash for `set` / `generated`. */
export type StoredPreviewPassword = { mode: PasswordMode; secret: { hash: string; salt: string } | null };

export type PreviewFilter = {
  state?: PreviewState | PreviewState[];
  hostId?: string;
  kind?: PreviewKind;
  projectId?: string;
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
                             visibility, ttl_expires_at, idle_after_ms, secret_level, template_id, project_id, owner,
                             password_mode, password_hash, password_salt, password_login, created_at, updated_at)
       VALUES ($id, $project, $host_id, $kind, $state, $source_kind, $source_json,
               $visibility, $ttl, $idle, $level, $template, $projectId, $owner,
               $pwMode, $pwHash, $pwSalt, $pwLogin, $now, $now)`,
      {
        id: p.id, project: p.project, host_id: p.hostId, kind: p.kind ?? "preview",
        state: p.state, source_kind, source_json, visibility: p.visibility,
        ttl: fromDate(p.ttlExpiresAt ?? null), idle: p.idleAfterMs ?? null, level: p.secretLevel ?? null, template: p.templateId ?? null, projectId: p.projectId ?? null, owner: p.owner ?? null,
        pwMode: p.password?.mode ?? "inherit", pwHash: p.password?.secret?.hash ?? null, pwSalt: p.password?.secret?.salt ?? null, pwLogin: p.passwordLogin ?? "inherit", now,
      },
    );
    return this.get(p.id)!;
  }

  get(id: string): Preview | undefined {
    const r = this.#db.get<PreviewRow>("SELECT * FROM previews WHERE id = $id", { id });
    return r ? rowToPreview(r) : undefined;
  }

  /** ADR-0021: who deployed it, or null (a PR, a workflow, a row from before 0010). */
  ownerOf(id: string): string | null {
    return this.#db.get<{ owner: string | null }>("SELECT owner FROM previews WHERE id = $id", { id })?.owner ?? null;
  }

  /** ADR-0023: the mode and hash. Not on `Preview`: only the gate reads the hash. */
  passwordOf(id: string): StoredPreviewPassword {
    const r = this.#db.get<{ password_mode: string | null; password_hash: string | null; password_salt: string | null }>(
      "SELECT password_mode, password_hash, password_salt FROM previews WHERE id = $id", { id });
    const mode = (r?.password_mode ?? "inherit") as PasswordMode;
    const secret = r?.password_hash && r.password_salt ? { hash: r.password_hash, salt: r.password_salt } : null;
    return { mode, secret: mode === "set" || mode === "generated" ? secret : null };
  }

  setPassword(id: string, pw: StoredPreviewPassword): void {
    this.#db.run(
      "UPDATE previews SET password_mode = $mode, password_hash = $hash, password_salt = $salt, updated_at = $now WHERE id = $id",
      { id, mode: pw.mode, hash: pw.secret?.hash ?? null, salt: pw.secret?.salt ?? null, now: this.#now() },
    );
  }

  setPasswordLogin(id: string, login: PasswordLogin): void {
    this.#db.run("UPDATE previews SET password_login = $login, updated_at = $now WHERE id = $id", { id, login, now: this.#now() });
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
    if (f.projectId) { where.push("project_id = $projectId"); params["projectId"] = f.projectId; }
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

  /** A redeploy that changed the runtime (ADR-0015). The kind never changes: an upload stays one. */
  setSource(id: string, source: PreviewSource): void {
    const { source_kind, source_json } = sourceToColumns(source);
    this.#db.run(
      "UPDATE previews SET source_kind = $source_kind, source_json = $source_json, updated_at = $now WHERE id = $id",
      { id, source_kind, source_json, now: this.#now() },
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

  /**
   * The live preview of a pull request, by its SOURCE (ADR-0011). Not by name: an unlisted
   * preview's project carries an unguessable suffix, so the name is not stable across
   * deploys of the same PR; the repository and number are.
   */
  findPullRequest(repo: string, number: number): Preview | undefined {
    const r = this.#db.get<PreviewRow>(
      `SELECT * FROM previews
        WHERE source_kind = 'pr' AND json_extract(source_json, '$.repo') = $repo AND json_extract(source_json, '$.number') = $number
          AND state != 'destroyed'
        ORDER BY id DESC LIMIT 1`,
      { repo, number },
    );
    return r ? rowToPreview(r) : undefined;
  }

  /** The forge-side objects a PR preview keeps current (ADR-0011): ids only. */
  forgeRefs(id: string): { commentId: number | null; deploymentId: number | null } {
    const r = this.#db.get<{ forge_comment_id: number | null; forge_deployment_id: number | null }>(
      "SELECT forge_comment_id, forge_deployment_id FROM previews WHERE id = $id", { id });
    return { commentId: r?.forge_comment_id ?? null, deploymentId: r?.forge_deployment_id ?? null };
  }

  setForgeRefs(id: string, refs: { commentId?: number | null; deploymentId?: number | null }): void {
    if (refs.commentId !== undefined) this.#db.run("UPDATE previews SET forge_comment_id = $v WHERE id = $id", { id, v: refs.commentId });
    if (refs.deploymentId !== undefined) this.#db.run("UPDATE previews SET forge_deployment_id = $v WHERE id = $id", { id, v: refs.deploymentId });
  }

  delete(id: string): boolean {
    return this.#db.run("DELETE FROM previews WHERE id = $id", { id }).changes > 0;
  }
}
