/**
 * `/v1/previews/:id/addons` (ADR-0017, ADR-0018): a preview's throwaway databases, and a
 * way to look inside them. Listing them is `previews.read`; reading or changing their DATA
 * is `previews.data` -- admin only until granted, and every query audited.
 */
import type { Hono } from "hono";
import { z } from "zod";
import { ADDON_IDS, type AddonId } from "@gangway/shared/addons";
import { badRequest, notFound } from "../../errors.ts";
import { readJson } from "../problem.ts";
import type { DataBrowser } from "../../previews/data/service.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

const addonParam = (s: string): AddonId => {
  if (!(ADDON_IDS as readonly string[]).includes(s)) throw notFound(`no such add-on: ${s}`);
  return s as AddonId;
};

const RowsQuery = z.object({
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
});
const KeysQuery = z.object({
  cursor: z.string().max(20).default("0"),
  match: z.string().max(256).default("*"),
});
const QueryBody = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(64 * 1024),
  write: z.boolean().default(false),
});

export function addonRoutes(api: Hono<AppEnv>, data: DataBrowser): void {
  api.get("/previews/:id/addons", requirePermission("previews.read"), (c) =>
    c.json({ addons: data.list(c.req.param("id")) }),
  );

  api.get("/previews/:id/addons/:addon/tables", requirePermission("previews.data"), async (c) =>
    c.json({
      tables: await data.tables(
        c.get("actor"),
        c.req.param("id"),
        addonParam(c.req.param("addon")),
      ),
    }),
  );

  api.get("/previews/:id/addons/:addon/rows", requirePermission("previews.data"), async (c) => {
    const q = RowsQuery.parse(c.req.query());
    return c.json(
      await data.rows(
        c.get("actor"),
        c.req.param("id"),
        addonParam(c.req.param("addon")),
        { schema: q.schema, name: q.table },
        q.limit,
        q.offset,
      ),
    );
  });

  api.get("/previews/:id/addons/redis/keys", requirePermission("previews.data"), async (c) => {
    const q = KeysQuery.parse(c.req.query());
    return c.json(await data.keys(c.get("actor"), c.req.param("id"), q.cursor, q.match));
  });

  api.get("/previews/:id/addons/redis/key", requirePermission("previews.data"), async (c) => {
    const name = c.req.query("name");
    if (name === undefined || name === "" || name.length > 1024)
      throw badRequest("?name= is the key");
    return c.json(await data.key(c.get("actor"), c.req.param("id"), name));
  });

  api.post("/previews/:id/addons/:addon/query", requirePermission("previews.data"), async (c) => {
    const body = QueryBody.parse(await readJson(c));
    return c.json(
      await data.query(
        c.get("actor"),
        c.req.param("id"),
        addonParam(c.req.param("addon")),
        body.text,
        body.write,
      ),
    );
  });
}
