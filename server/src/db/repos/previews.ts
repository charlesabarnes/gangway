import { must } from "@gangway/shared/must";
import type { PreviewIcon } from "@gangway/shared/preview-icon";
import type {
  PasswordLogin,
  PasswordMode,
  Preview,
  PreviewSource,
  PreviewState,
  WatermarkChoice,
} from "@gangway/shared/domain";
import type { Provenance } from "../../auth/actor.ts";
import type { Db, Params } from "../types.ts";
import { fromDate, rowToPreview, sourceToColumns, type PreviewRow } from "./mappers.ts";
import type { CreatePreview, PreviewFilter, StoredPreviewPassword } from "./preview-inputs.ts";

export type { CreatePreview, PreviewFilter, StoredPreviewPassword } from "./preview-inputs.ts";

const watermarkColumn = (w: WatermarkChoice | undefined): string | null =>
  w === "on" || w === "off" ? w : null;

const choiceColumns = (p: CreatePreview) => ({
  watermark: watermarkColumn(p.watermark),
  domain: p.domain ?? null,
});

const labelColumns = (p: CreatePreview) => ({
  title: p.title ?? null,
  icon: p.icon?.name ?? null,
  iconColor: p.icon?.color ?? null,
});

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
      `INSERT INTO previews (id, project, title, icon, icon_color, host_id, kind, state, source_kind, source_json,
                             visibility, ttl_expires_at, idle_after_ms, secret_level, template_id, project_id, owner, credential,
                             password_mode, password_hash, password_salt, password_login, signed_in_only, watermark, domain, created_at, updated_at)
       VALUES ($id, $project, $title, $icon, $iconColor, $host_id, $kind, $state, $source_kind, $source_json,
               $visibility, $ttl, $idle, $level, $template, $projectId, $owner, $credential,
               $pwMode, $pwHash, $pwSalt, $pwLogin, $only, $watermark, $domain, $now, $now)`,
      {
        id: p.id,
        project: p.project,
        ...labelColumns(p),
        host_id: p.hostId,
        kind: p.kind ?? "preview",
        state: p.state,
        source_kind,
        source_json,
        visibility: p.visibility,
        ttl: fromDate(p.ttlExpiresAt ?? null),
        idle: p.idleAfterMs ?? null,
        level: p.secretLevel ?? null,
        template: p.templateId ?? null,
        projectId: p.projectId ?? null,
        owner: p.owner ?? null,
        credential: p.credential ?? null,
        pwMode: p.password?.mode ?? "inherit",
        pwHash: p.password?.secret?.hash ?? null,
        pwSalt: p.password?.secret?.salt ?? null,
        pwLogin:
          p.passwordLogin === "only" || p.passwordLogin === undefined ? "inherit" : p.passwordLogin,
        only: p.passwordLogin === "only" ? 1 : 0,
        ...choiceColumns(p),
        now,
      },
    );
    return must(this.get(p.id), "the preview just saved");
  }

  get(id: string): Preview | undefined {
    const r = this.#db.get("SELECT * FROM previews WHERE id = $id", { id }) as
      PreviewRow | undefined;
    return r ? rowToPreview(r) : undefined;
  }

  ownerOf(id: string): string | null {
    return this.provenanceOf(id).owner;
  }

  provenanceOf(id: string): Provenance {
    const r = this.#db.get("SELECT owner, credential FROM previews WHERE id = $id", { id }) as
      { owner: string | null; credential: string | null } | undefined;
    return { owner: r?.owner ?? null, credential: r?.credential ?? null };
  }

  provenances(): Map<string, Provenance> {
    const rows = this.#db.query("SELECT id, owner, credential FROM previews") as {
      id: string;
      owner: string | null;
      credential: string | null;
    }[];
    return new Map(rows.map((r) => [r.id, { owner: r.owner, credential: r.credential }]));
  }

  passwordOf(id: string): StoredPreviewPassword {
    const r = this.#db.get(
      "SELECT password_mode, password_hash, password_salt FROM previews WHERE id = $id",
      { id },
    ) as
      | {
          password_mode: string | null;
          password_hash: string | null;
          password_salt: string | null;
        }
      | undefined;
    const mode = (r?.password_mode ?? "inherit") as PasswordMode;
    const secret =
      r?.password_hash && r.password_salt ? { hash: r.password_hash, salt: r.password_salt } : null;
    return { mode, secret: mode === "set" || mode === "generated" ? secret : null };
  }

  setPassword(id: string, pw: StoredPreviewPassword): void {
    this.#db.run(
      "UPDATE previews SET password_mode = $mode, password_hash = $hash, password_salt = $salt, updated_at = $now WHERE id = $id",
      {
        id,
        mode: pw.mode,
        hash: pw.secret?.hash ?? null,
        salt: pw.secret?.salt ?? null,
        now: this.#now(),
      },
    );
  }

  envCiphertext(id: string): string | null {
    return (
      (
        this.#db.get("SELECT env_ciphertext FROM previews WHERE id = $id", { id }) as
          { env_ciphertext: string | null } | undefined
      )?.env_ciphertext ?? null
    );
  }

  setEnvCiphertext(id: string, sealed: string | null): void {
    this.#db.run("UPDATE previews SET env_ciphertext = $v, updated_at = $now WHERE id = $id", {
      id,
      v: sealed,
      now: this.#now(),
    });
  }

  setTitle(id: string, title: string | null): void {
    this.#db.run("UPDATE previews SET title = $title, updated_at = $now WHERE id = $id", {
      id,
      title,
      now: this.#now(),
    });
  }

  setTtlExpiresAt(id: string, at: Date | null): void {
    this.#db.run("UPDATE previews SET ttl_expires_at = $at, updated_at = $now WHERE id = $id", {
      id,
      at: at === null ? null : at.getTime(),
      now: this.#now(),
    });
  }

  setWatermark(id: string, watermark: WatermarkChoice): void {
    this.#db.run("UPDATE previews SET watermark = $w, updated_at = $now WHERE id = $id", {
      id,
      w: watermarkColumn(watermark),
      now: this.#now(),
    });
  }

  /** The preview's own choice, then its repository's; null when both follow the setting. */
  watermarkOf(id: string): boolean | null {
    const r = this.#db.get(
      `SELECT p.watermark AS own, pr.watermark AS project FROM previews p
       LEFT JOIN projects pr ON pr.id = p.project_id WHERE p.id = $id`,
      { id },
    ) as { own: string | null; project: string | null } | undefined;
    const w = r?.own ?? r?.project ?? null;
    return w === null ? null : w === "on";
  }

  setDomain(id: string, domain: string | null): void {
    this.#db.run("UPDATE previews SET domain = $d, updated_at = $now WHERE id = $id", {
      id,
      d: domain,
      now: this.#now(),
    });
  }

  /** Stops every preview and project choosing this domain, so they follow the next level up. */
  forgetDomain(domain: string): void {
    const now = this.#now();
    this.#db.run("UPDATE previews SET domain = NULL, updated_at = $now WHERE domain = $d", {
      d: domain,
      now,
    });
    this.#db.run("UPDATE projects SET domain = NULL, updated_at = $now WHERE domain = $d", {
      d: domain,
      now,
    });
  }

  /** Whether a preview that is not destroyed, or a project, has chosen this domain. */
  domainChosen(domain: string): boolean {
    const row = this.#db.get(
      `SELECT (SELECT COUNT(*) FROM previews WHERE domain = $d AND state != 'destroyed')
            + (SELECT COUNT(*) FROM projects WHERE domain = $d) AS n`,
      { d: domain },
    ) as { n: number } | undefined;
    return must(row, "a count row").n > 0;
  }

  setIcon(id: string, icon: PreviewIcon | null): void {
    this.#db.run(
      "UPDATE previews SET icon = $icon, icon_color = $color, updated_at = $now WHERE id = $id",
      { id, icon: icon?.name ?? null, color: icon?.color ?? null, now: this.#now() },
    );
  }

  setPasswordLogin(id: string, login: PasswordLogin): void {
    if (login === "only") {
      this.#db.run("UPDATE previews SET signed_in_only = 1, updated_at = $now WHERE id = $id", {
        id,
        now: this.#now(),
      });
    } else {
      this.#db.run(
        "UPDATE previews SET signed_in_only = 0, password_login = $login, updated_at = $now WHERE id = $id",
        { id, login, now: this.#now() },
      );
    }
  }

  getByProject(project: string): Preview | undefined {
    const r = this.#db.get("SELECT * FROM previews WHERE project = $p", { p: project }) as
      PreviewRow | undefined;
    return r ? rowToPreview(r) : undefined;
  }

  list(f: PreviewFilter = {}): Preview[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (f.state) {
      const states = Array.isArray(f.state) ? f.state : [f.state];
      const placeholders = states.map((_, i) => `$s${i}`).join(", ");
      where.push(`state IN (${placeholders})`);
      Object.assign(params, Object.fromEntries(states.map((s, i) => [`s${i}`, s])));
    }
    if (f.hostId) {
      where.push("host_id = $hostId");
      params["hostId"] = f.hostId;
    }
    if (f.kind) {
      where.push("kind = $kind");
      params["kind"] = f.kind;
    }
    if (f.projectId) {
      where.push("project_id = $projectId");
      params["projectId"] = f.projectId;
    }
    if (f.owner !== undefined) {
      where.push("owner = $owner");
      params["owner"] = f.owner;
    }
    if (f.credential !== undefined) {
      where.push("credential = $credential");
      params["credential"] = f.credential;
    }
    if (f.before !== undefined) {
      where.push("id < $before");
      params["before"] = f.before;
    }
    if (!f.includeDestroyed && !f.state) {
      where.push("state != 'destroyed'");
    }
    if (f.limit !== undefined) {
      params["limit"] = f.limit;
    }

    const whereClause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT * FROM previews${whereClause} ORDER BY id DESC${f.limit !== undefined ? " LIMIT $limit" : ""}`;
    return this.#previews(sql, Object.keys(params).length ? params : undefined);
  }

  /** Deletes previews destroyed before `cutoff`, with their events and builds; their ids. */
  purgeDestroyedBefore(cutoff: number): string[] {
    const ids = (
      this.#db.query("SELECT id FROM previews WHERE state = 'destroyed' AND destroyed_at < $c", {
        c: cutoff,
      }) as { id: string }[]
    ).map((r) => r.id);
    for (const id of ids) {
      this.#db.run("DELETE FROM previews WHERE id = $id", { id });
    }
    return ids;
  }

  setState(id: string, state: PreviewState, error: string | null = null): void {
    this.#db.run(
      `UPDATE previews SET state = $state, error = $error, updated_at = $now,
         destroyed_at = CASE WHEN $state = 'destroyed' THEN $now ELSE destroyed_at END
       WHERE id = $id`,
      { id, state, error, now: this.#now() },
    );
  }

  setSource(id: string, source: PreviewSource): void {
    const { source_kind, source_json } = sourceToColumns(source);
    this.#db.run(
      "UPDATE previews SET source_kind = $source_kind, source_json = $source_json, updated_at = $now WHERE id = $id",
      { id, source_kind, source_json, now: this.#now() },
    );
  }

  // Runs on every proxied request: keep it cheap and never bump updated_at.
  touch(id: string, at: number = this.#now()): void {
    this.#db.run("UPDATE previews SET last_seen_at = $at WHERE id = $id", { id, at });
  }

  touchMany(seen: ReadonlyMap<string, number>): number {
    if (seen.size === 0) {
      return 0;
    }
    return this.#db.transaction(() => {
      let n = 0;
      for (const [id, at] of seen) {
        n += this.#db.run(
          "UPDATE previews SET last_seen_at = $at WHERE id = $id AND COALESCE(last_seen_at, 0) < $at",
          { id, at },
        ).changes;
      }
      return n;
    });
  }

  // A project's production preview never lapses, whatever TTL it had before it was chosen.
  expired(now: number = this.#now()): Preview[] {
    return this.#previews(
      `SELECT * FROM previews
       WHERE ttl_expires_at IS NOT NULL AND ttl_expires_at <= $now
         AND state NOT IN ('destroyed', 'destroying')
         AND id NOT IN (SELECT production_preview_id FROM projects
                        WHERE production_preview_id IS NOT NULL)
       ORDER BY ttl_expires_at`,
      { now },
    );
  }

  /** The project whose production this preview is, or null. */
  productionOf(id: string): string | null {
    const r = this.#db.get("SELECT slug FROM projects WHERE production_preview_id = $id LIMIT 1", {
      id,
    }) as { slug: string } | null | undefined;
    return r?.slug ?? null;
  }

  idleSince(cutoff: number): Preview[] {
    return this.#previews(
      `SELECT * FROM previews
       WHERE state = 'awake' AND kind = 'preview'
         AND COALESCE(last_seen_at, created_at) <= $cutoff`,
      { cutoff },
    );
  }

  #previews(sql: string, params?: Params): Preview[] {
    return (this.#db.query(sql, params) as PreviewRow[]).map(rowToPreview);
  }

  // By source, not name: an unlisted preview's name changes across deploys.
  findPullRequest(repo: string, number: number): Preview | undefined {
    const r = this.#db.get(
      `SELECT * FROM previews
        WHERE ((source_kind = 'pr' AND json_extract(source_json, '$.repo') = $repo AND json_extract(source_json, '$.number') = $number)
            OR (source_kind = 'tarball' AND json_extract(source_json, '$.pr.repo') = $repo AND json_extract(source_json, '$.pr.number') = $number))
          AND state != 'destroyed'
        ORDER BY id DESC LIMIT 1`,
      { repo, number },
    ) as PreviewRow | undefined;
    return r ? rowToPreview(r) : undefined;
  }

  forgeRefs(id: string): { commentId: number | null; deploymentId: number | null } {
    const r = this.#db.get(
      "SELECT forge_comment_id, forge_deployment_id FROM previews WHERE id = $id",
      { id },
    ) as { forge_comment_id: number | null; forge_deployment_id: number | null } | undefined;
    return { commentId: r?.forge_comment_id ?? null, deploymentId: r?.forge_deployment_id ?? null };
  }

  setForgeRefs(
    id: string,
    refs: { commentId?: number | null; deploymentId?: number | null },
  ): void {
    if (refs.commentId !== undefined) {
      this.#db.run("UPDATE previews SET forge_comment_id = $v WHERE id = $id", {
        id,
        v: refs.commentId,
      });
    }
    if (refs.deploymentId !== undefined) {
      this.#db.run("UPDATE previews SET forge_deployment_id = $v WHERE id = $id", {
        id,
        v: refs.deploymentId,
      });
    }
  }

  delete(id: string): boolean {
    return this.#db.run("DELETE FROM previews WHERE id = $id", { id }).changes > 0;
  }
}
