import { z } from "zod";
import type { Actor } from "../auth/actor.ts";
import { must } from "@gangway/shared/must";
import { unprocessable } from "../errors.ts";
import { EXTEND_FOREVER, extendPreview } from "../previews/extend.ts";
import { IDLE_NEVER, setPreviewIdle } from "../previews/idle.ts";
import { describePreview } from "./describe.ts";
import { resolveFor } from "./resolve.ts";
import { plain } from "./tool-specs.ts";
import type { ToolDeps } from "./tool-deps.ts";

export const ExtendArgs = z.object({
  preview: z.string().min(1).max(2048).describe("The preview's name, id or URL."),
  by: z
    .string()
    .min(1)
    .max(16)
    .optional()
    .describe(
      `How much longer it lives, added to what it has left, like "2h", "7d" or "4w"; "${EXTEND_FOREVER}" keeps it until it is destroyed.`,
    ),
  idle: z
    .string()
    .min(1)
    .max(16)
    .optional()
    .describe(
      `How long without a request before it sleeps, like "30m" or "2h"; "${IDLE_NEVER}" keeps it awake. A sleeping preview wakes on its next request, so this is for an app that must answer at once or works in the background.`,
    ),
});
export type ExtendArgs = z.infer<typeof ExtendArgs>;

export const EXTEND_TOOL = {
  title: "Extend a preview",
  description:
    "Keep a preview longer than its TTL (by), or change when it sleeps for want of requests (idle), or both. Use it when the user wants a preview kept, or kept awake; status shows when each one expires.",
  inputSchema: plain(ExtendArgs),
  annotations: { destructiveHint: false, idempotentHint: false },
};

export function extend(d: ToolDeps, actor: Actor, args: ExtendArgs): string {
  const { ctx } = d;
  if (args.by === undefined && args.idle === undefined) {
    throw unprocessable('say how much longer it lives ("by"), when it sleeps ("idle"), or both');
  }
  const id = resolveFor(ctx, actor, args.preview).id;
  let p = args.by === undefined ? undefined : extendPreview(ctx, actor, id, args.by);
  const said: string[] = [];
  if (p !== undefined) {
    said.push(p.ttlExpiresAt ? `until ${p.ttlExpiresAt.toISOString()}` : "never expires");
  }
  if (args.idle !== undefined) {
    p = setPreviewIdle(ctx, actor, id, args.idle);
    said.push(p.idleAfterMs === 0 ? "stays awake" : `sleeps after ${args.idle.trim()} idle`);
  }
  return `extended: ${describePreview(ctx, must(p, "the preview just changed"))} (${said.join("; ")})`;
}
