/**
 * A repository's secrets (ADR-0012): one encrypted JSON map on the `repos` row, each entry
 * a value AND a level. Names and levels are listable; values leave this process exactly
 * twice -- into `<checkout>/.env`, and from there into the containers -- and only those
 * at or below the preview's clearance. `set`/`unset`/`levels` merge, because the API
 * never returns a value for the browser to send back.
 */
import { SECRET_LEVELS, clears, type Clearance, type Repo, type SecretLevel } from "../../../shared/src/domain.ts";
import type { AuditSink } from "../audit/audit.ts";
import type { Actor } from "../auth/actor.ts";
import type { ReposRepo } from "../db/repos/repos.ts";
import { unprocessable } from "../errors.ts";
import type { SecretBox } from "./box.ts";

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_ENTRIES = 100;
export const MAX_ENV_VALUE_BYTES = 16 * 1024;

export type SecretEntry = { value: string; level: SecretLevel };
export type SecretListing = { name: string; level: SecretLevel };

export type SecretChange = {
  /** A plain string sets the value at `standard` (or keeps the level of an existing entry). */
  set?: Record<string, string | SecretEntry> | undefined;
  unset?: string[] | undefined;
  /** Re-level without re-entering the value. */
  levels?: Record<string, SecretLevel> | undefined;
};

export class RepoEnv {
  readonly #repos: ReposRepo;
  readonly #box: SecretBox;
  readonly #audit: AuditSink | undefined;

  constructor(repos: ReposRepo, box: SecretBox, audit?: AuditSink) {
    this.#repos = repos;
    this.#box = box;
    this.#audit = audit;
  }

  #all(repoId: string): Record<string, SecretEntry> {
    const sealed = this.#repos.envCiphertext(repoId);
    if (sealed === null) return {};
    const parsed = JSON.parse(this.#box.open(sealed)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, SecretEntry> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // The first shape was a bare string; it meant what `standard` means now.
      if (typeof v === "string") out[k] = { value: v, level: "standard" };
      else if (typeof v === "object" && v !== null && typeof (v as SecretEntry).value === "string") {
        const level = (v as SecretEntry).level;
        out[k] = { value: (v as SecretEntry).value, level: SECRET_LEVELS.includes(level) ? level : "standard" };
      }
    }
    return out;
  }

  /** The values a preview with this clearance may have, for a deploy. Never for a response. */
  valuesFor(repoId: string, clearance: Clearance): Record<string, string> {
    if (clearance === "none") return {};
    const out: Record<string, string> = {};
    for (const [k, e] of Object.entries(this.#all(repoId))) if (clears(clearance, e.level)) out[k] = e.value;
    return out;
  }

  list(repoId: string): SecretListing[] {
    return Object.entries(this.#all(repoId)).map(([name, e]) => ({ name, level: e.level })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Merges. Returns the listing afterwards. */
  update(actor: Actor | null, repo: Repo, change: SecretChange): SecretListing[] {
    const current = this.#all(repo.id);
    const before = Object.keys(current).sort();
    for (const [k, v] of Object.entries(change.set ?? {})) {
      if (!ENV_NAME_RE.test(k)) throw unprocessable(`"${k}" is not a valid environment variable name`, { name: k });
      const entry: SecretEntry = typeof v === "string" ? { value: v, level: current[k]?.level ?? "standard" } : v;
      if (Buffer.byteLength(entry.value, "utf8") > MAX_ENV_VALUE_BYTES) throw unprocessable(`"${k}" is longer than ${MAX_ENV_VALUE_BYTES} bytes`, { name: k });
      if (!SECRET_LEVELS.includes(entry.level)) throw unprocessable(`"${k}": level must be one of ${SECRET_LEVELS.join(", ")}`, { name: k });
      current[k] = entry;
    }
    for (const [k, level] of Object.entries(change.levels ?? {})) {
      if (!current[k]) throw unprocessable(`"${k}" is not set`, { name: k });
      if (!SECRET_LEVELS.includes(level)) throw unprocessable(`"${k}": level must be one of ${SECRET_LEVELS.join(", ")}`, { name: k });
      current[k] = { ...current[k]!, level };
    }
    for (const k of change.unset ?? []) delete current[k];
    const names = Object.keys(current).sort();
    if (names.length > MAX_ENV_ENTRIES) throw unprocessable(`a repository may hold at most ${MAX_ENV_ENTRIES} variables`);
    this.#repos.setEnvCiphertext(repo.id, names.length === 0 ? null : this.#box.seal(JSON.stringify(current)));
    // Names and levels only, ever: the audit log is readable by more people than the values are.
    this.#audit?.record(actor, "repo.env.changed", repo.id, {
      old: { names: before },
      new: { names, set: Object.keys(change.set ?? {}).sort(), unset: [...(change.unset ?? [])].sort(), levels: change.levels ?? {} },
    });
    return this.list(repo.id);
  }
}

/**
 * The `.env` line for one variable, in the form compose reads back exactly: double-quoted,
 * with the characters that would end or escape the string escaped. Compose expands
 * `\\n` inside double quotes, so a multi-line value survives too.
 */
export function dotenvLine(name: string, value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\$/g, "\\$");
  return `${name}="${escaped}"`;
}
