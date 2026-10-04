import type { Hono } from "hono";
import { OrgCreateSchema } from "@gangway/shared/orgs-api";
import { notFound } from "../../errors.ts";
import { createOrg, type OrgDeps } from "../../tenancy/orgs.ts";
import type { AppEnv } from "../env.ts";
import { readJson } from "../problem.ts";
import { requirePermission } from "../middleware/auth.ts";

/** The server's operator acting on orgs by id: never a tenant's route. */
export function operatorRoutes(api: Hono<AppEnv>, d: OrgDeps): void {
  api.get("/operator/orgs", requirePermission("instance.orgs"), (c) =>
    c.json({ orgs: d.orgs.list() }),
  );

  api.post("/operator/orgs", requirePermission("instance.orgs"), async (c) => {
    const req = OrgCreateSchema.parse(await readJson(c));
    return c.json({ org: createOrg(d, c.get("actor"), req) }, 201);
  });

  api.get("/operator/orgs/:id", requirePermission("instance.orgs"), (c) => {
    const org = d.orgs.get(c.req.param("id"));
    if (!org) {
      throw notFound(`no such org: ${c.req.param("id")}`);
    }
    return c.json({ org, limits: d.orgs.limitsOf(org.id) ?? null });
  });
}
