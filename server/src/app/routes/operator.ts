import type { Hono } from "hono";
import {
  OrgCreateSchema,
  OrgLimitsChangeSchema,
  SuspendSchema,
  TakedownSchema,
} from "@gangway/shared/orgs-api";
import { actorId } from "../../auth/actor.ts";
import { badRequest, notFound } from "../../errors.ts";
import { createOrg, type OrgDeps } from "../../tenancy/orgs.ts";
import {
  liftTakedown,
  resumeOrg,
  suspendOrg,
  takeDown,
  type SuspendDeps,
} from "../../tenancy/suspend.ts";
import type { AppEnv } from "../env.ts";
import { readJson } from "../problem.ts";
import { requirePermission } from "../middleware/auth.ts";

export type OperatorDeps = OrgDeps & Omit<SuspendDeps, "orgs" | "audit">;

const sinceOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const since = Number(raw);
  if (!Number.isSafeInteger(since) || since < 0) {
    throw badRequest("changedSince is a time in milliseconds since 1970", { changedSince: raw });
  }
  return since;
};

/** The server's operator acting on orgs by id: never a tenant's route. */
export function operatorRoutes(api: Hono<AppEnv>, d: OperatorDeps): void {
  // With changedSince, only the orgs whose people or state changed after it: what seat billing reads.
  api.get("/operator/orgs", requirePermission("instance.orgs"), (c) =>
    c.json({ orgs: d.orgs.seats(sinceOf(c.req.query("changedSince"))) }),
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
    const label = req.planLabel === undefined ? (before?.planLabel ?? null) : req.planLabel;
    d.orgs.setLimits(org.id, label, req.limits, actorId(actor));
    const after = d.orgs.limitsOf(org.id) ?? null;
    d.audit.record(actor, "org.limits", org.id, { old: before, new: after });
    return c.json({ org, limits: after });
  });

  api.post("/operator/orgs/:id/suspend", requirePermission("instance.orgs"), async (c) => {
    const { reason } = SuspendSchema.parse(await readJson(c));
    return c.json(await suspendOrg(d, c.get("actor"), c.req.param("id"), reason));
  });

  api.post("/operator/orgs/:id/resume", requirePermission("instance.orgs"), (c) =>
    c.json({ org: resumeOrg(d, c.get("actor"), c.req.param("id")) }),
  );

  api.post("/operator/previews/:id/takedown", requirePermission("instance.orgs"), async (c) => {
    const { reason } = TakedownSchema.parse(await readJson(c));
    return c.json(await takeDown(d, c.get("actor"), c.req.param("id"), reason));
  });

  api.get("/operator/takedowns", requirePermission("instance.orgs"), (c) =>
    c.json({ takedowns: d.takedowns.list() }),
  );

  api.delete("/operator/takedowns/:hostname", requirePermission("instance.orgs"), (c) =>
    c.json({ takedown: liftTakedown(d, c.get("actor"), c.req.param("hostname")) }),
  );
}
