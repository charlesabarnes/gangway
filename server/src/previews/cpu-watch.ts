import { tmpdir } from "node:os";
import type { Host } from "@gangway/shared/domain";
import { LABEL } from "../docker/labels.ts";
import { errorMessage } from "../errors.ts";
import { withOrg } from "../tenancy/scope.ts";
import type { LifecycleContext, PreviewContext } from "./context.ts";
import { sleepPreview } from "./sleep.ts";

export type CpuWatchContext = LifecycleContext & Pick<PreviewContext, "audit" | "instance">;

/** Busy for every sample this long means mining, not a build or a burst of traffic. */
export const CPU_ABUSE = { cores: 0.9, samples: 15 };
const SAMPLE_TIMEOUT_MS = 30_000;

const sampled = (h: Host) => h.runtime === "runsc" && h.state !== "unreachable";

/** Sleeps and flags a preview on a sandboxed host that holds a core for `CPU_ABUSE.samples` runs. */
export class CpuWatch {
  readonly #ctx: CpuWatchContext;
  readonly #streaks = new Map<string, number>();

  constructor(ctx: CpuWatchContext) {
    this.#ctx = ctx;
  }

  async sample(signal?: AbortSignal): Promise<string[]> {
    const busy = new Map<string, number>();
    for (const host of this.#ctx.hosts.list().filter(sampled)) {
      if (signal?.aborted) {
        return [];
      }
      try {
        for (const [id, cores] of await this.#cores(host, signal)) {
          busy.set(id, (busy.get(id) ?? 0) + cores);
        }
      } catch (err) {
        this.#ctx.logger.warn("could not read a host's CPU use", { hostId: host.id, err });
      }
    }
    const flagged: string[] = [];
    for (const id of [...this.#streaks.keys()].filter((k) => !busy.has(k))) {
      this.#streaks.delete(id);
    }
    for (const [id, cores] of busy) {
      if (cores < CPU_ABUSE.cores) {
        this.#streaks.delete(id);
        continue;
      }
      const streak = (this.#streaks.get(id) ?? 0) + 1;
      this.#streaks.set(id, streak);
      if (streak >= CPU_ABUSE.samples && (await this.#flag(id, cores))) {
        this.#streaks.delete(id);
        flagged.push(id);
      }
    }
    return flagged;
  }

  /** Cores in use per preview: `docker stats` gives 100% for each core. */
  async #cores(host: Host, signal?: AbortSignal): Promise<Map<string, number>> {
    const run = (args: string[]) => {
      const timeout = AbortSignal.timeout(SAMPLE_TIMEOUT_MS);
      return this.#ctx.compose.capture([this.#ctx.docker ?? "docker", ...args], host, {
        cwd: tmpdir(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    };
    const ps = await run([
      "ps",
      "--filter",
      `label=${LABEL.instance}=${this.#ctx.instance}`,
      "--filter",
      `label=${LABEL.previewId}`,
      "--format",
      `{{.ID}} {{.Label "${LABEL.previewId}"}}`,
    ]);
    const owner = new Map<string, string>();
    for (const [id, preview] of lines(ps.stdout).map((l) => l.split(" "))) {
      if (id && preview) {
        owner.set(id, preview);
      }
    }
    if (ps.code !== 0 || owner.size === 0) {
      return new Map();
    }
    const stats = await run([
      "stats",
      "--no-stream",
      "--format",
      "{{.ID}} {{.CPUPerc}}",
      ...owner.keys(),
    ]);
    const cores = new Map<string, number>();
    for (const [id, perc] of lines(stats.stdout).map((l) => l.split(" "))) {
      const preview = [...owner].find(([c]) => id && c.startsWith(id))?.[1];
      const n = Number.parseFloat(perc ?? "");
      if (preview && Number.isFinite(n)) {
        cores.set(preview, (cores.get(preview) ?? 0) + n / 100);
      }
    }
    return cores;
  }

  async #flag(previewId: string, cores: number): Promise<boolean> {
    const ctx = this.#ctx;
    const p = ctx.previews.get(previewId);
    if (p?.state !== "awake" || p.kind !== "preview") {
      return false;
    }
    const why = `it used ${cores.toFixed(1)} cores for ${CPU_ABUSE.samples} min straight`;
    try {
      await withOrg(p.orgId, () => sleepPreview(ctx, previewId, why));
    } catch (err) {
      ctx.logger.warn("could not sleep a preview that held the CPU", {
        previewId,
        err: errorMessage(err),
      });
      return false;
    }
    ctx.audit.record(null, "preview.cpu_abuse", previewId, {
      new: { orgId: p.orgId, cores: Number(cores.toFixed(2)), minutes: CPU_ABUSE.samples },
    });
    ctx.logger.warn("slept a preview that held the CPU", { previewId, orgId: p.orgId, cores });
    return true;
  }
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
