import { z } from "zod";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./logger.ts";

export const LATEST_RELEASE_URL =
  "https://api.github.com/repos/charlesabarnes/gangway/releases/latest";

export type UpdateStatus = {
  current: string;
  enabled: boolean;
  latest: string | null;
  available: boolean;
  url: string | null;
  checkedAt: string | null;
};

type Release = { latest: string; url: string; checkedAt: number };

const ReleaseSchema = z.object({ tag_name: z.string().min(1), html_url: z.string().url() });

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// An edge or dev build is off the release line, so no release counts as newer.
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export type UpdateCheckOptions = {
  current: string;
  enabled: () => boolean;
  logger: Logger;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
};

export class UpdateCheck {
  readonly #o: UpdateCheckOptions;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;
  #last: Release | null = null;

  constructor(o: UpdateCheckOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
  }

  status(): UpdateStatus {
    const { current } = this.#o;
    const enabled = this.#o.enabled();
    const last = enabled ? this.#last : null;
    return {
      current,
      enabled,
      latest: last?.latest ?? null,
      available: last !== null && isNewer(last.latest, current),
      url: last?.url ?? null,
      checkedAt: last ? new Date(last.checkedAt).toISOString() : null,
    };
  }

  /** Never throws: a failed check keeps the last good result. */
  async check(signal?: AbortSignal): Promise<void> {
    if (!this.#o.enabled()) return;
    const timeout = AbortSignal.timeout(this.#o.timeoutMs ?? 10_000);
    try {
      const res = await this.#fetch(LATEST_RELEASE_URL, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `gangway/${this.#o.current}`,
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) {
        this.#o.logger.warn("update check failed", { status: res.status });
        return;
      }
      const release = ReleaseSchema.parse(await res.json());
      this.#last = {
        latest: release.tag_name.replace(/^v/, ""),
        url: release.html_url,
        checkedAt: (this.#o.now ?? Date.now)(),
      };
    } catch (err) {
      if (signal?.aborted) return;
      this.#o.logger.warn("update check failed", { err: errorMessage(err) });
    }
  }
}
