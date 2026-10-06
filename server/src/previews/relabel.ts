import { conflict, errorMessage, notFound } from "../errors.ts";
import type { PreviewContext } from "./context.ts";

/** Gives a live preview a new name in place: same containers, volumes and secrets. */
export function relabelPreview(
  ctx: Pick<PreviewContext, "table" | "logs" | "orgSuffix" | "previews">,
  previewId: string,
  label: string,
): Map<string, string> {
  const preview = ctx.previews.get(previewId);
  if (!preview) {
    throw notFound(`no such preview: ${previewId}`);
  }
  const primary = ctx.table.forPreview(previewId).find((e) => e.primary);
  if (!primary) {
    return new Map();
  }
  const from = primary.hostname.split(".")[0] ?? "";
  const org = ctx.orgSuffix?.(preview.orgId) ?? null;
  const to = org === null ? label : `${label}--${org}`;
  let moves: Map<string, string>;
  try {
    moves = ctx.table.relabel(previewId, from, to);
  } catch (e) {
    throw conflict(errorMessage(e));
  }
  for (const [a, b] of moves) {
    ctx.logs.append(previewId, "system", `renamed ${a} to ${b}`);
  }
  return moves;
}
