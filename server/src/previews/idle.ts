import { must } from "@gangway/shared/must";
import type { Preview } from "@gangway/shared/domain";
import { parseDuration } from "@gangway/shared/duration";
import { mayRebuild, type Actor } from "../auth/actor.ts";
import { conflict, forbidden, unprocessable } from "../errors.ts";
import { admitChange } from "../tenancy/limits.ts";
import type { ComposeModel } from "./compose-model.ts";
import type { PreviewContext } from "./context.ts";

export const IDLE_NEVER = "never";

export function idleWindowMs(idle: string): number {
  const text = idle.trim();
  if (text === IDLE_NEVER) {
    return 0;
  }
  const ms = parseDuration(text);
  if (ms === null || ms <= 0) {
    throw unprocessable(`"${idle}" is not a duration like 30m, 2h or 1d, or "${IDLE_NEVER}"`);
  }
  return ms;
}

/** Changes when a preview sleeps for want of requests; "never" keeps it awake. */
export function setPreviewIdle(
  ctx: Pick<PreviewContext, "previews" | "audit" | "blocks">,
  actor: Actor,
  previewId: string,
  idle: string,
): Preview {
  admitChange(ctx, actor.orgId);
  if (!mayRebuild(actor, ctx.previews.provenanceOf(previewId))) {
    throw forbidden(
      'changing when a preview sleeps needs "previews.update", or "previews.update_own" on a preview you deployed',
    );
  }
  const ms = idleWindowMs(idle);
  const p = ctx.previews.get(previewId);
  if (!p || p.state === "destroyed" || p.state === "destroying") {
    throw conflict("this preview is being torn down or already gone");
  }
  if (p.idleAfterMs === ms) {
    return p;
  }
  ctx.previews.setIdleAfterMs(previewId, ms);
  ctx.audit.record(actor, "preview.idle", previewId, { old: p.idleAfterMs, new: ms });
  return must(ctx.previews.get(previewId), "the preview just changed");
}

/** After a redeploy: an `idle` the new source states replaces the one the preview had. */
export function followStackIdle(
  ctx: Pick<PreviewContext, "previews">,
  previewId: string,
  model: ComposeModel,
): void {
  const stated = model.x.idle;
  if (stated === undefined) {
    return;
  }
  const ms = idleWindowMs(stated);
  if (ctx.previews.get(previewId)?.idleAfterMs !== ms) {
    ctx.previews.setIdleAfterMs(previewId, ms);
  }
}
