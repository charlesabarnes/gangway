/**
 * A repository's secrets (ADR-0012): one encrypted JSON map on the `repos` row. Names are
 * listable; values leave this process exactly twice -- into `<checkout>/.env`, and from
 * there into the containers. `set`/`unset` merge, because the API never returns a value
 * for the browser to send back.
 */
import type { Repo } from "../../../shared/src/domain.ts";
import type { AuditSink } from "../audit/audit.ts";
import type { Actor } from "../auth/actor.ts";
import type { ReposRepo } from "../db/repos/repos.ts";
import { unprocessable } from "../errors.ts";
import type { SecretBox } from "./box.ts";

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_ENTRIES = 100;
export const MAX_ENV_VALUE_BYTES = 16 * 1024;

export class RepoEnv {
  readonly #repos: ReposRepo;
  readonly #box: SecretBox;
  readonly #audit: AuditSink | undefined;

  constructor(repos: ReposRepo, box: SecretBox, audit?: AuditSink) {
    this.#repos = repos;
    this.#box = box;
    this.#audit = audit;
  }

  /** The values, for a deploy. Never for a response. */
  valuesFor(repoId: string): Record<string, string> {
    const sealed = this.#repos.envCiphertext(repoId);
    if (sealed === null) return {};
    const parsed = JSON.parse(this.#box.open(sealed)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  }

  names(repoId: string): string[] {
    return Object.keys(this.valuesFor(repoId)).sort();
  }

  /** Merges: `set` overwrites or adds, `unset` removes. Returns the names afterwards. */
  update(actor: Actor | null, repo: Repo, change: { set?: Record<string, string> | undefined; unset?: string[] | undefined }): string[] {
    const current = this.valuesFor(repo.id);
    const before = Object.keys(current).sort();
    for (const [k, v] of Object.entries(change.set ?? {})) {
      if (!ENV_NAME_RE.test(k)) throw unprocessable(`"${k}" is not a valid environment variable name`, { name: k });
      if (Buffer.byteLength(v, "utf8") > MAX_ENV_VALUE_BYTES) throw unprocessable(`"${k}" is longer than ${MAX_ENV_VALUE_BYTES} bytes`, { name: k });
      current[k] = v;
    }
    for (const k of change.unset ?? []) delete current[k];
    const names = Object.keys(current).sort();
    if (names.length > MAX_ENV_ENTRIES) throw unprocessable(`a repository may hold at most ${MAX_ENV_ENTRIES} variables`);
    this.#repos.setEnvCiphertext(repo.id, names.length === 0 ? null : this.#box.seal(JSON.stringify(current)));
    // Names only, ever: the audit log is readable by more people than the values are.
    this.#audit?.record(actor, "repo.env.changed", repo.id, { old: { names: before }, new: { names, set: Object.keys(change.set ?? {}).sort(), unset: [...(change.unset ?? [])].sort() } });
    return names;
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
