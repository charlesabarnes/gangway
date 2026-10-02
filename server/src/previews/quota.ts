import { servedByGangway, type Preview } from "@gangway/shared/domain";
import { principalOf, type Actor } from "../auth/actor.ts";
import { conflict } from "../errors.ts";
import type { PreviewContext } from "./context.ts";

/** How many container previews may be up at once; 0 leaves a limit off. */
export type PreviewQuota = { active: number; perUser: number };

// A failed preview's stack is already down, and a static site gangway serves is a few files on
// disk. An asleep one counts: the next visit starts it again.
const running = (p: Preview) =>
  !["failed", "destroying", "destroyed"].includes(p.state) && !servedByGangway(p);

/**
 * Each preview is confined on its own, so only a count keeps a burst of deploys (a loop in an
 * agent, a leaked token) from filling the host. Checked before a new preview's row exists.
 */
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
