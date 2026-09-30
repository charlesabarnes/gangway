import type { Context, Hono } from "hono";
import type { Preview } from "@gangway/shared/domain";
import {
  PreviewExtendSchema,
  PreviewIconChangeSchema,
  PreviewPasswordChangeSchema,
  PreviewTitleChangeSchema,
  PreviewWatermarkChangeSchema,
} from "@gangway/shared/api";
import { PreviewDomainChangeSchema } from "@gangway/shared/domains-api";
import { forbidden } from "../../errors.ts";
import { mayRebuild } from "../../auth/actor.ts";
import type { PreviewContext } from "../../previews/context.ts";
import { setPreviewDomain } from "../../previews/domain.ts";
import { extendPreview } from "../../previews/extend.ts";
import { setPreviewPassword } from "../../previews/password.ts";
import { setPreviewWatermark } from "../../previews/watermark.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { readJson } from "../problem.ts";
import type { Previews } from "./previews.ts";

function changeable(ctx: PreviewContext, c: Context<AppEnv>, p: Preview, what: string): void {
  if (!mayRebuild(c.get("actor"), ctx.previews.provenanceOf(p.id))) {
    throw forbidden(
      `this preview was deployed by someone else: "previews.update_own" covers only your own, and changing any preview's ${what} needs "previews.update"`,
    );
  }
}

function titleRoutes(api: Hono<AppEnv>, { ctx, wire, find }: Previews): void {
  api.put(
    "/previews/:id/title",
    requirePermission("previews.update_own", "previews.update"),
    async (c) => {
      const p = find(c.req.param("id"));
      changeable(ctx, c, p, "title");
      const { title } = PreviewTitleChangeSchema.parse(await readJson(c));
      ctx.previews.setTitle(p.id, title);
      ctx.audit.record(c.get("actor"), "preview.title", p.id, { old: p.title, new: title });
      return c.json({ preview: wire(find(p.id)) });
    },
  );
  api.put(
    "/previews/:id/watermark",
    requirePermission("previews.update_own", "previews.update"),
    async (c) => {
      const p = find(c.req.param("id"));
      changeable(ctx, c, p, "watermark");
      const { watermark } = PreviewWatermarkChangeSchema.parse(await readJson(c));
      setPreviewWatermark(ctx, c.get("actor"), p.id, watermark);
      return c.json({ preview: wire(find(p.id)) });
    },
  );
  api.put("/previews/:id/domain", requirePermission("previews.domain"), async (c) => {
    const p = find(c.req.param("id"));
    changeable(ctx, c, p, "domain");
    const { domain } = PreviewDomainChangeSchema.parse(await readJson(c));
    setPreviewDomain(ctx, c.get("actor"), p.id, domain);
    return c.json({ preview: wire(find(p.id)) });
  });
  api.put("/previews/:id/ttl", requirePermission("previews.extend"), async (c) => {
    const p = find(c.req.param("id"));
    changeable(ctx, c, p, "expiry");
    const { extend } = PreviewExtendSchema.parse(await readJson(c));
    return c.json({ preview: wire(extendPreview(ctx, c.get("actor"), p.id, extend)) });
  });
  api.put(
    "/previews/:id/icon",
    requirePermission("previews.update_own", "previews.update"),
    async (c) => {
      const p = find(c.req.param("id"));
      changeable(ctx, c, p, "icon");
      const { icon } = PreviewIconChangeSchema.parse(await readJson(c));
      ctx.previews.setIcon(p.id, icon);
      ctx.audit.record(c.get("actor"), "preview.icon", p.id, { old: p.icon, new: icon });
      return c.json({ preview: wire(find(p.id)) });
    },
  );
}

function passwordRoutes(api: Hono<AppEnv>, { ctx, wire, find }: Previews): void {
  api.put(
    "/previews/:id/password",
    requirePermission("previews.update_own", "previews.update"),
    async (c) => {
      const p = find(c.req.param("id"));
      const actor = c.get("actor");
      changeable(ctx, c, p, "password");
      const body = await readJson(c);
      const { password, login } = PreviewPasswordChangeSchema.parse(body);
      return c.json({
        preview: wire(
          await setPreviewPassword(ctx, { actor, previewId: p.id, choice: password, login }),
        ),
      });
    },
  );
}

/** Changes to one preview's settings: title, watermark, domain, expiry, icon and password. */
export function previewChangeRoutes(api: Hono<AppEnv>, previews: Previews): void {
  passwordRoutes(api, previews);
  titleRoutes(api, previews);
}
