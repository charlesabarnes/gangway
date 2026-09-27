import type { Context, Hono } from "hono";
import type { Preview } from "@gangway/shared/domain";
import { PreviewShareSchema } from "@gangway/shared/api";
import type { Actor } from "../../auth/actor.ts";
import type { PreviewContext } from "../../previews/context.ts";
import { shareStatus, startShare, stopShare } from "../../previews/share.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

// Sharing is like changing the preview: startShare / stopShare also need the right to rebuild it.
export function shareRoutes(
  api: Hono<AppEnv>,
  ctx: PreviewContext,
  find: (id: string, actor: Actor) => Preview,
): void {
  const visible = (c: Context<AppEnv>) => find(c.req.param("id") ?? "", c.get("actor"));
  api.get("/previews/:id/share", requirePermission("previews.read", "previews.read_own"), (c) =>
    c.json(shareStatus(ctx, visible(c).id)),
  );
  api.post("/previews/:id/share", requirePermission("previews.share"), async (c) => {
    const p = visible(c);
    const { ttl } = PreviewShareSchema.parse(await readJson(c));
    await startShare(ctx, c.get("actor"), p.id, ttl);
    return c.json(shareStatus(ctx, p.id));
  });
  api.delete("/previews/:id/share", requirePermission("previews.share"), (c) => {
    const p = visible(c);
    stopShare(ctx, c.get("actor"), p.id);
    return c.json(shareStatus(ctx, p.id));
  });
}
