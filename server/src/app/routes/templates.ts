import type { Hono } from "hono";
import { TemplateCreateSchema, TemplatePatchSchema } from "../../../../shared/src/api.ts";
import type { Template } from "../../../../shared/src/domain.ts";
import type { AuditSink } from "../../audit/audit.ts";
import type { HostsRepo } from "../../db/repos/hosts.ts";
import type { TemplatesRepo } from "../../db/repos/templates.ts";
import { conflict, notFound, unprocessable } from "../../errors.ts";
import { readJson } from "../problem.ts";
import { parseDuration } from "../../util/duration.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export type TemplateRouteDeps = {
  templates: TemplatesRepo;
  hosts: Pick<HostsRepo, "get">;
  audit: AuditSink;
  /** The trigger defaults from settings: a template one of them names cannot be deleted. */
  namedByTrigger: (id: string) => string[];
};

/**
 * `/v1/templates` (ADR-0013): named preview policies. Anyone who can read previews can
 * list them -- a deployer picks one; changing them is `templates.manage`. `default` is
 * edited like any other and never deleted.
 */
export function templateRoutes(api: Hono<AppEnv>, d: TemplateRouteDeps): void {
  api.get("/templates", requirePermission("previews.read"), (c) =>
    c.json({ templates: d.templates.list() }),
  );

  api.get("/templates/:id", requirePermission("previews.read"), (c) => {
    const t = d.templates.get(c.req.param("id"));
    if (!t) throw notFound(`no such template: ${c.req.param("id")}`);
    return c.json({ template: t });
  });

  api.post("/templates", requirePermission("templates.manage"), async (c) => {
    const body = await readJson(c);
    const req = TemplateCreateSchema.parse(body);
    check(req, d.hosts);
    if (d.templates.get(req.id))
      throw conflict(`template "${req.id}" already exists`, { id: req.id });
    const t = d.templates.create(req);
    d.audit.record(c.get("actor"), "template.created", t.id, { old: null, new: pick(t) });
    return c.json({ template: t }, 201);
  });

  api.patch("/templates/:id", requirePermission("templates.manage"), async (c) => {
    const id = c.req.param("id");
    const before = d.templates.get(id);
    if (!before) throw notFound(`no such template: ${id}`);
    const body = await readJson(c);
    const patch = TemplatePatchSchema.parse(body);
    check(patch, d.hosts);
    const after = d.templates.update(id, patch)!;
    d.audit.record(c.get("actor"), "template.updated", id, { old: pick(before), new: pick(after) });
    return c.json({ template: after });
  });

  api.delete("/templates/:id", requirePermission("templates.manage"), (c) => {
    const id = c.req.param("id");
    const before = d.templates.get(id);
    if (!before) throw notFound(`no such template: ${id}`);
    if (before.builtin) throw conflict(`"${id}" is built in and cannot be deleted`, { id });
    const triggers = d.namedByTrigger(id);
    if (triggers.length > 0)
      throw conflict(
        `"${id}" is the default template for ${triggers.join(", ")}; point those elsewhere first`,
        { id, triggers },
      );
    const repos = d.templates.repoCount(id);
    d.templates.delete(id);
    d.audit.record(c.get("actor"), "template.deleted", id, {
      old: { ...pick(before), repos },
      new: null,
    });
    return c.body(null, 204);
  });
}

/** What the schema cannot say: durations parse, and a named host exists. */
function check(
  v: {
    ttl?: string | null | undefined;
    idleAfter?: string | undefined;
    hostId?: string | null | undefined;
  },
  hosts: Pick<HostsRepo, "get">,
): void {
  if (v.ttl !== undefined && v.ttl !== null && parseDuration(v.ttl) === null)
    throw unprocessable(`ttl ${JSON.stringify(v.ttl)} is not a duration like 12h or 7d`);
  if (v.idleAfter !== undefined && v.idleAfter !== "never" && parseDuration(v.idleAfter) === null)
    throw unprocessable(
      `idleAfter ${JSON.stringify(v.idleAfter)} is not a duration like 30m, or never`,
    );
  if (v.hostId !== undefined && v.hostId !== null && !hosts.get(v.hostId))
    throw unprocessable(`host "${v.hostId}" does not exist`, { hostId: v.hostId });
}

const pick = (t: Template) => ({
  name: t.name,
  visibility: t.visibility,
  ttl: t.ttl,
  idleAfter: t.idleAfter,
  clearance: t.clearance,
  hostId: t.hostId,
});
