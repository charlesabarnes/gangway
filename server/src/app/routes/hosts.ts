import type { Hono } from "hono";
import type { Host } from "@gangway/shared/domain";
import { HostIdSchema, HostRegisterSchema } from "@gangway/shared/hosts-api";
import type { AuditSink } from "../../audit/audit.ts";
import type { HostsRepo } from "../../db/repos/hosts.ts";
import type { OrgsRepo } from "../../db/repos/orgs.ts";
import type { PreviewsRepo } from "../../db/repos/previews.ts";
import { badRequest, conflict, notFound, unprocessable } from "../../errors.ts";
import { redactString } from "../../logger.ts";
import { acrossOrgs } from "../../tenancy/scope.ts";
import type { AppEnv } from "../env.ts";
import { readJson } from "../problem.ts";
import { requirePermission } from "../middleware/auth.ts";

export type HostRouteDeps = {
  hosts: HostsRepo;
  orgs: Pick<OrgsRepo, "get">;
  previews: Pick<PreviewsRepo, "list">;
  audit: AuditSink;
};

const toWire = (h: Host) => ({ ...h, dockerHost: redactString(h.dockerHost) });

const idOf = (raw: string) => {
  const id = HostIdSchema.safeParse(raw);
  if (!id.success) {
    throw badRequest(`bad host id: ${raw}`);
  }
  return id.data;
};

export function hostRoutes(api: Hono<AppEnv>, d: HostRouteDeps): void {
  const { hosts } = d;

  api.get("/hosts", requirePermission("hosts.read"), (c) =>
    c.json({ hosts: hosts.list().map(toWire) }),
  );

  const inService = (id: string) => {
    const h = hosts.list().find((x) => x.id === id);
    if (!h) {
      throw notFound(`no such host: ${id}`);
    }
    return h;
  };

  const runningOn = (id: string) => acrossOrgs(() => d.previews.list({ hostId: id })).length;

  api.put("/hosts/:id", requirePermission("hosts.manage"), async (c) => {
    const id = idOf(c.req.param("id"));
    const req = HostRegisterSchema.parse(await readJson(c));
    const before = hosts.get(id);
    if (before?.managedBy === "config") {
      throw conflict(`host "${id}" is named in the config file; change it there`, { hostId: id });
    }
    if (req.orgId !== null && !d.orgs.get(req.orgId)) {
      throw unprocessable(`no such org: ${req.orgId}`, { orgId: req.orgId });
    }
    const clash = hosts.named(req.name);
    if (clash && clash.id !== id) {
      throw conflict(`host "${clash.id}" already has the name ${req.name}`, { hostId: clash.id });
    }
    const host = hosts.upsert({ id, ...req, managedBy: "api" });
    d.audit.record(c.get("actor"), "host.registered", id, {
      old: before ? toWire(before) : null,
      new: toWire(host),
    });
    return c.json({ host: toWire(host) }, before ? 200 : 201);
  });

  api.post("/hosts/:id/drain", requirePermission("hosts.manage"), (c) => {
    const id = idOf(c.req.param("id"));
    inService(id);
    hosts.setDraining(id, true);
    d.audit.record(c.get("actor"), "host.drained", id);
    return c.json({ host: toWire(inService(id)), previews: runningOn(id) });
  });

  api.delete("/hosts/:id/drain", requirePermission("hosts.manage"), (c) => {
    const id = idOf(c.req.param("id"));
    inService(id);
    hosts.setDraining(id, false);
    d.audit.record(c.get("actor"), "host.undrained", id);
    return c.json({ host: toWire(inService(id)) });
  });

  // Refused while a preview still runs there; the autoscaler drains first, then waits for none.
  api.delete("/hosts/:id", requirePermission("hosts.manage"), (c) => {
    const id = idOf(c.req.param("id"));
    const host = inService(id);
    if (host.managedBy === "config") {
      throw conflict(`host "${id}" is named in the config file; remove it there`, { hostId: id });
    }
    const running = runningOn(id);
    if (running > 0) {
      throw conflict(`host "${id}" still runs ${running} preview(s); drain it and wait`, {
        hostId: id,
        previews: running,
      });
    }
    hosts.remove(id);
    d.audit.record(c.get("actor"), "host.removed", id, { old: toWire(host) });
    return c.body(null, 204);
  });
}
