import { z } from "zod";
import type { Actor } from "../auth/actor.ts";
import { SHARE_LIMITS, shareStatus, startShare, stopShare } from "../previews/share.ts";
import { resolveFor } from "./resolve.ts";
import { plain } from "./tool-specs.ts";
import type { ToolDeps } from "./tool-deps.ts";

export const ShareArgs = z.object({
  preview: z.string().min(1).max(2048).describe("The preview's name, id or URL."),
  action: z
    .enum(["start", "stop", "status"])
    .default("status")
    .describe(
      "start gives the preview a public link (or returns the one it has), stop ends it, status says whether it has one.",
    ),
  ttl: z
    .string()
    .max(16)
    .optional()
    .describe('start only: how long the link lasts, like "30m" or "4h"; the server caps it.'),
});
export type ShareArgs = z.infer<typeof ShareArgs>;

export const SHARE_TOOL = {
  title: "Share a preview publicly",
  description:
    "Give a preview a public https link through a Cloudflare quick tunnel, for someone who cannot reach this gangway: on a local-only install (previews under *.localhost) it is the only way. Ask the user before starting one. " +
    SHARE_LIMITS,
  inputSchema: plain(ShareArgs),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export async function manageShare(d: ToolDeps, actor: Actor, args: ShareArgs): Promise<string> {
  const { ctx } = d;
  const preview = resolveFor(ctx, actor, args.preview);
  if (args.action === "start") {
    const share = await startShare(ctx, actor, preview.id, args.ttl);
    const until = new Date(share.expiresAt).toISOString();
    return `shared: ${share.url}/ until ${until} (stop it with action "stop")\n${SHARE_LIMITS}`;
  }
  if (args.action === "stop") {
    const ended = stopShare(ctx, actor, preview.id);
    return ended ? `stopped sharing: ${ended.url} no longer answers` : "it was not shared";
  }
  const status = shareStatus(ctx, preview.id);
  if (status.share)
    return `shared: ${status.share.url}/ until ${new Date(status.share.expiresAt).toISOString()}`;
  if (!status.available) return "not shared, and this server cannot share previews";
  return status.local
    ? "not shared: it answers only on the machine gangway runs on; start a share for a public link"
    : "not shared";
}
