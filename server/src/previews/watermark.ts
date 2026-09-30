import type { WatermarkChoice } from "@gangway/shared/domain";
import { can, type Actor } from "../auth/actor.ts";
import { forbidden } from "../errors.ts";
import type { PreviewContext } from "./context.ts";

/** Choosing the mark, even "inherit", is its own permission, so a plan can hold it back. */
export function checkWatermarkAllowed(actor: Actor, choice: WatermarkChoice | undefined): void {
  if (choice !== undefined && !can(actor, "previews.watermark")) {
    throw forbidden('switching the gangway watermark needs "previews.watermark"');
  }
}

/** Takes effect on the next page load: gangway stamps the mark per request. */
export function setPreviewWatermark(
  ctx: Pick<PreviewContext, "previews" | "audit">,
  actor: Actor,
  previewId: string,
  choice: WatermarkChoice,
): void {
  checkWatermarkAllowed(actor, choice);
  const old = ctx.previews.get(previewId)?.watermark ?? "inherit";
  if (old === choice) {
    return;
  }
  ctx.previews.setWatermark(previewId, choice);
  ctx.audit.record(actor, "preview.watermark", previewId, { old, new: choice });
}
