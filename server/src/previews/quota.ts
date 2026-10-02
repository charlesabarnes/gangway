import { servedByGangway, type Preview } from "@gangway/shared/domain";
import { principalOf, type Actor } from "../auth/actor.ts";
import { conflict } from "../errors.ts";
import type { PreviewContext } from "./context.ts";

export type PreviewQuota = { active: number; perUser: number };

// A failed preview's stack is down and a served site is files; an asleep one wakes on a visit.
const running = (p: Preview) =>
  !["failed", "destroying", "destroyed"].includes(p.state) && !servedByGangway(p);

export function checkQuota(ctx: Pick<PreviewContext, "previews" | "quota">, actor: Actor): void {
  const q = ctx.quota?.();
  if (!q) {
    return;
  }
  if (q.active > 0) {
    const all = ctx.previews.list().filter(running).length;
    if (all >= q.active) {
      throw conflict(
        `this server already runs ${all} previews, its limit (previews.limits.active); destroy one first`,
      );
    }
  }
  const owner = principalOf(actor);
  if (q.perUser > 0 && owner !== null) {
    const mine = ctx.previews.list({ owner }).filter(running).length;
    if (mine >= q.perUser) {
      throw conflict(
        `you already run ${mine} previews, the most one user may (previews.limits.activePerUser); destroy one first`,
      );
    }
  }
}
