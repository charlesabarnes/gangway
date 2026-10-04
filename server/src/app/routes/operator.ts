import type { Hono } from "hono";
import { OrgCreateSchema, OrgLimitsChangeSchema } from "@gangway/shared/orgs-api";
import { actorId } from "../../auth/actor.ts";
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

  const orgOf = (id: string) => {
    const org = d.orgs.get(id);
    if (!org) {
      throw notFound(`no such org: ${id}`);
    }
    return org;
  };

  api.get("/operator/orgs/:id", requirePermission("instance.orgs"), (c) => {
    const org = orgOf(c.req.param("id"));
    return c.json({ org, limits: d.orgs.limitsOf(org.id) ?? null });
  });

  // What a billing system calls when a plan changes; the same call twice changes nothing more.
  api.put("/operator/orgs/:id/limits", requirePermission("instance.orgs"), async (c) => {
    const org = orgOf(c.req.param("id"));
    const req = OrgLimitsChangeSchema.parse(await readJson(c));
    const actor = c.get("actor");
    const before = d.orgs.limitsOf(org.id) ?? null;
    d.orgs.setLimits(org.id, req.planLabel ?? null, req.limits, actorId(actor));
    const after = d.orgs.limitsOf(org.id) ?? null;
    d.audit.record(actor, "org.limits", org.id, { old: before, new: after });
    return c.json({ org, limits: after });
  });
}
