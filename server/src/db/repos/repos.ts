import type { Clearance, ForgeId, ForkPolicy, Repo, Visibility } from "../../../../shared/src/domain.ts";
import type { Db, Params } from "../types.ts";
import { num, rowToRepo, type RepoRow } from "./mappers.ts";

export type CreateRepo = {
  id: string; forge: ForgeId; fullName: string; installationId: string; slug: string;
  enabled?: boolean; disabledReason?: string | null;
};

/** Absent AND undefined both mean "leave it": zod's optional output is passed straight through. */
export type RepoPatch = {
  slug?: string | undefined; enabled?: boolean | undefined; disabledReason?: string | null | undefined; installationId?: string | undefined;
  visibility?: Visibility | null | undefined; ttl?: string | null | undefined; forks?: ForkPolicy | undefined; drafts?: boolean | undefined;
  prClearance?: Clearance | undefined; forkClearance?: Clearance | undefined;
};

const COLUMNS: Record<keyof RepoPatch, string> = {
  slug: "slug", enabled: "enabled", disabledReason: "disabled_reason", installationId: "installation_id",
  visibility: "visibility", ttl: "ttl", forks: "forks", drafts: "drafts",
  prClearance: "pr_clearance", forkClearance: "fork_clearance",
};

/** Repositories a forge sends pull requests from, and how their previews are shaped (ADR-0011). */
export class ReposRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(r: CreateRepo): Repo {
    const now = this.#now();
    this.#db.run(
      `INSERT INTO repos (id, forge, full_name, installation_id, slug, enabled, disabled_reason, created_at, updated_at)
       VALUES ($id, $forge, $fullName, $installationId, $slug, $enabled, $reason, $now, $now)`,
      { id: r.id, forge: r.forge, fullName: r.fullName, installationId: r.installationId, slug: r.slug, enabled: num(r.enabled ?? true), reason: r.disabledReason ?? null, now },
    );
    return this.get(r.id)!;
  }

  get(id: string): Repo | undefined {
    const r = this.#db.get<RepoRow>("SELECT * FROM repos WHERE id = $id", { id });
    return r ? rowToRepo(r) : undefined;
  }

  getByFullName(forge: ForgeId, fullName: string): Repo | undefined {
    const r = this.#db.get<RepoRow>("SELECT * FROM repos WHERE forge = $forge AND full_name = $fullName", { forge, fullName });
    return r ? rowToRepo(r) : undefined;
  }

  getBySlug(slug: string): Repo | undefined {
    const r = this.#db.get<RepoRow>("SELECT * FROM repos WHERE slug = $slug", { slug });
    return r ? rowToRepo(r) : undefined;
  }

  list(): Repo[] {
    return this.#db.query<RepoRow>("SELECT * FROM repos ORDER BY forge, full_name").map(rowToRepo);
  }

  /** A partial update; only the keys present are written. Returns the row afterwards. */
  update(id: string, patch: RepoPatch): Repo | undefined {
    const sets: string[] = [];
    const params: Params = { id, now: this.#now() };
    for (const [k, v] of Object.entries(patch) as [keyof RepoPatch, unknown][]) {
      if (v === undefined) continue;
      sets.push(`${COLUMNS[k]} = $${k}`);
      params[k] = typeof v === "boolean" ? num(v) : (v as string | null);
    }
    if (sets.length === 0) return this.get(id);
    this.#db.run(`UPDATE repos SET ${sets.join(", ")}, updated_at = $now WHERE id = $id`, params);
    return this.get(id);
  }

  /** The sealed secrets map (ADR-0012); the repo never sees plaintext. */
  envCiphertext(id: string): string | null {
    return this.#db.get<{ env_ciphertext: string | null }>("SELECT env_ciphertext FROM repos WHERE id = $id", { id })?.env_ciphertext ?? null;
  }

  setEnvCiphertext(id: string, sealed: string | null): void {
    this.#db.run("UPDATE repos SET env_ciphertext = $v, updated_at = $now WHERE id = $id", { id, v: sealed, now: this.#now() });
  }

  delete(id: string): boolean {
    return this.#db.run("DELETE FROM repos WHERE id = $id", { id }).changes > 0;
  }
}
