import { systemActor } from "../auth/actor.ts";
import type { Logger } from "../logger.ts";
import type { PreviewContext } from "../previews/context.ts";
import { destroy } from "../previews/destroy.ts";

export type SweepReport = {
  expired: number;
  destroyed: string[];
  skipped: string[];
  failed: string[];
};

// Previews on unreachable hosts are skipped: down would fail and mark them failed.
export async function sweepExpired(
  ctx: PreviewContext,
  logger: Logger,
  signal?: AbortSignal,
): Promise<SweepReport> {
  const expired = ctx.previews.expired(ctx.now());
  const report: SweepReport = { expired: expired.length, destroyed: [], skipped: [], failed: [] };
  const actor = systemActor("ttl-sweep");
  for (const p of expired) {
    if (signal?.aborted) break;
    if (ctx.teardowns.has(p.id) || ctx.hosts.get(p.hostId)?.state === "unreachable") {
      report.skipped.push(p.id);
      continue;
    }
    try {
      ctx.logs.append(p.id, "system", `ttl expired at ${p.ttlExpiresAt?.toISOString() ?? "?"}`);
      await destroy(ctx, p.id, actor);
      report.destroyed.push(p.id);
    } catch (err) {
      report.failed.push(p.id);
      logger.warn("ttl sweep could not destroy a preview", {
        previewId: p.id,
        project: p.project,
        err,
      });
    }
  }
  if (report.destroyed.length || report.failed.length) {
    logger.info("ttl sweep", {
      destroyed: report.destroyed.length,
      failed: report.failed.length,
      skipped: report.skipped.length,
    });
  }
  return report;
}

export function flushLastSeen(ctx: Pick<PreviewContext, "table" | "previews">): number {
  return ctx.previews.touchMany(ctx.table.drainSeen());
}
