/**
 * Secrets: two scopes, one shape. The global map reaches every preview; a repository's
 * map reaches previews of that repository and wins on a name both hold.
 * Every entry has a value and a level; a preview is deployed with a clearance and
 * receives the entries at or below it.
 *
 * Both maps are one encrypted JSON blob each -- the repository's on its `repos` row, the
 * global one in the settings store under `secrets.global` -- sealed by the same key in
 * the state directory. Names and levels are listable; values leave this process exactly
 * twice: into `<checkout>/.env`, and from there into the containers. `set`/`unset`/`levels`
 * merge, because the API never returns a value for the browser to send back.
 */
import { SECRET_LEVELS, clears, type Clearance, type SecretLevel } from "@gangway/shared/domain";
import type { AuditAction, AuditSink } from "../audit/audit.ts";
import type { Actor } from "../auth/actor.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import { unprocessable } from "../errors.ts";
import type { SettingsStore } from "../settings.ts";
import type { SecretBox } from "./box.ts";

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_ENTRIES = 100;
export const MAX_ENV_VALUE_BYTES = 16 * 1024;
const GLOBAL_KEY = "secrets.global";

export type SecretEntry = { value: string; level: SecretLevel };
export type SecretListing = { name: string; level: SecretLevel };

export type SecretChange = {
  /** A plain string sets the value at `standard` (or keeps the level of an existing entry). */
  set?: Record<string, string | SecretEntry> | undefined;
  unset?: string[] | undefined;
  /** Re-level without re-entering the value. */
  levels?: Record<string, SecretLevel> | undefined;
};

type Backend = { read(): string | null; write(sealed: string | null): void };

/** One sealed map: the global one, or a repository's. */
export class SecretMap {
  readonly #backend: Backend;
  readonly #box: SecretBox;
  readonly #audit: { sink: AuditSink | undefined; action: AuditAction; target: string | null };

  constructor(
    backend: Backend,
    box: SecretBox,
    audit: { sink: AuditSink | undefined; action: AuditAction; target: string | null },
  ) {
    this.#backend = backend;
    this.#box = box;
    this.#audit = audit;
  }

  all(): Record<string, SecretEntry> {
    const sealed = this.#backend.read();
    if (sealed === null) return {};
    const parsed = JSON.parse(this.#box.open(sealed)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, SecretEntry> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // A bare string is the older shape, read as `standard`.
      if (typeof v === "string") out[k] = { value: v, level: "standard" };
      else if (
        typeof v === "object" &&
        v !== null &&
        typeof (v as SecretEntry).value === "string"
      ) {
        const level = (v as SecretEntry).level;
        out[k] = {
          value: (v as SecretEntry).value,
          level: SECRET_LEVELS.includes(level) ? level : "standard",
        };
      }
    }
    return out;
  }

  list(): SecretListing[] {
    return Object.entries(this.all())
      .map(([name, e]) => ({ name, level: e.level }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Merges. Returns the listing afterwards. */
  update(actor: Actor | null, change: SecretChange): SecretListing[] {
    const current = this.all();
    const before = Object.keys(current).sort();
    for (const [k, v] of Object.entries(change.set ?? {})) {
      if (!ENV_NAME_RE.test(k))
        throw unprocessable(`"${k}" is not a valid environment variable name`, { name: k });
      const entry: SecretEntry =
        typeof v === "string" ? { value: v, level: current[k]?.level ?? "standard" } : v;
      if (Buffer.byteLength(entry.value, "utf8") > MAX_ENV_VALUE_BYTES)
        throw unprocessable(`"${k}" is longer than ${MAX_ENV_VALUE_BYTES} bytes`, { name: k });
      if (!SECRET_LEVELS.includes(entry.level))
        throw unprocessable(`"${k}": level must be one of ${SECRET_LEVELS.join(", ")}`, {
          name: k,
        });
      current[k] = entry;
    }
    for (const [k, level] of Object.entries(change.levels ?? {})) {
      if (!current[k]) throw unprocessable(`"${k}" is not set`, { name: k });
      if (!SECRET_LEVELS.includes(level))
        throw unprocessable(`"${k}": level must be one of ${SECRET_LEVELS.join(", ")}`, {
          name: k,
        });
      current[k] = { ...current[k], level };
    }
    for (const k of change.unset ?? []) delete current[k];
    const names = Object.keys(current).sort();
    if (names.length > MAX_ENV_ENTRIES)
      throw unprocessable(`at most ${MAX_ENV_ENTRIES} variables may be held here`);
    this.#backend.write(names.length === 0 ? null : this.#box.seal(JSON.stringify(current)));
    // Names and levels only, ever: the audit log is readable by more people than the values are.
    this.#audit.sink?.record(actor, this.#audit.action, this.#audit.target, {
      old: { names: before },
      new: {
        names,
        set: Object.keys(change.set ?? {}).sort(),
        unset: [...(change.unset ?? [])].sort(),
        levels: change.levels ?? {},
      },
    });
    return this.list();
  }
}

export class Secrets {
  readonly #projects: ProjectsRepo;
  readonly #store: SettingsStore;
  readonly #box: SecretBox;
  readonly #audit: AuditSink | undefined;

  constructor(projects: ProjectsRepo, store: SettingsStore, box: SecretBox, audit?: AuditSink) {
    this.#projects = projects;
    this.#store = store;
    this.#box = box;
    this.#audit = audit;
  }

  global(): SecretMap {
    return new SecretMap(
      {
        read: () => {
          const v = this.#store.get(GLOBAL_KEY);
          return typeof v === "string" && v !== "" ? v : null;
        },
        write: (s) => this.#store.set(GLOBAL_KEY, s ?? ""),
      },
      this.#box,
      { sink: this.#audit, action: "secrets.changed", target: null },
    );
  }

  project(projectId: string): SecretMap {
    return new SecretMap(
      {
        read: () => this.#projects.envCiphertext(projectId),
        write: (s) => this.#projects.setEnvCiphertext(projectId, s),
      },
      this.#box,
      { sink: this.#audit, action: "project.env.changed", target: projectId },
    );
  }

  /**
   * What a preview receives: the global entries, then the project's over them, each
   * filtered by the clearance. `none` is nothing at all. Never for a response.
   */
  valuesFor(projectId: string | null, clearance: Clearance): Record<string, string> {
    if (clearance === "none") return {};
    const out: Record<string, string> = {};
    const take = (m: Record<string, SecretEntry>) => {
      for (const [k, e] of Object.entries(m)) if (clears(clearance, e.level)) out[k] = e.value;
    };
    take(this.global().all());
    if (projectId !== null) take(this.project(projectId).all());
    return out;
  }
}

/**
 * The `.env` line for one variable, in the form compose reads back exactly: double-quoted,
 * with the characters that would end or escape the string escaped. Compose expands
 * `\\n` inside double quotes, so a multi-line value survives too.
 */
export function dotenvLine(name: string, value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\$/g, "\\$");
  return `${name}="${escaped}"`;
}
