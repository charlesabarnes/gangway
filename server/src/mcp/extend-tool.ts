import { z } from "zod";
import type { Actor } from "../auth/actor.ts";
import { EXTEND_FOREVER, extendPreview } from "../previews/extend.ts";
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
    .describe(
      `How much longer it lives, added to what it has left, like "2h", "7d" or "4w"; "${EXTEND_FOREVER}" keeps it until it is destroyed.`,
    ),
});
export type ExtendArgs = z.infer<typeof ExtendArgs>;

export const EXTEND_TOOL = {
  title: "Extend a preview",
  description:
    "Keep a preview longer than its TTL: push back when it expires, or make it never expire. Use it when the user wants a preview kept; status shows when each one expires.",
  inputSchema: plain(ExtendArgs),
  annotations: { destructiveHint: false, idempotentHint: false },
};

export function extend(d: ToolDeps, actor: Actor, args: ExtendArgs): string {
  const { ctx } = d;
  const p = extendPreview(ctx, actor, resolveFor(ctx, actor, args.preview).id, args.by);
  const until = p.ttlExpiresAt ? ` (until ${p.ttlExpiresAt.toISOString()})` : " (never expires)";
  return `extended: ${describePreview(ctx, p)}${until}`;
}
