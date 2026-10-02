import type { Hono } from "hono";
import {
  DomainClaimForPreviewSchema,
  DomainClaimSchema,
  ProductionChangeSchema,
} from "@gangway/shared/domains-api";
import type { Preview, Project } from "@gangway/shared/domain";
import { maySee, type Actor } from "../../auth/actor.ts";
import type { ProjectsRepo } from "../../db/repos/projects.ts";
import {
  assertMayManage,
  checkDomain,
  claimDomain,
  domainsOf,
  removeDomain,
  targetOf,
  type ClaimDeps,
} from "../../domains/claims.ts";
import { notFound, unprocessable } from "../../errors.ts";
import { keepForProduction } from "../../previews/extend.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export type DomainRouteDeps = ClaimDeps & { projects: ProjectsRepo };

const ANY = ["domains.manage", "repos.domains", "previews.domain"] as const;

function projectOf(d: DomainRouteDeps, ref: string): Project {
  const p = d.projects.find(ref);
  if (!p) {
    throw notFound(`no such project: ${ref}`);
  }
  return p;
}

/** A preview the actor can see; one it cannot answers as not found. */
function previewOf(d: DomainRouteDeps, actor: Actor, id: string): Preview {
  const p = d.previews.get(id);
  if (!p || p.state === "destroyed" || !maySee(actor, d.previews.provenanceOf(id))) {
    throw notFound(`no such preview: ${id}`);
  }
  return p;
}

function claimOf(d: DomainRouteDeps, id: string) {
  const claim = d.domains.get(id);
  if (!claim) {
    throw notFound(`no such domain: ${id}`);
  }
  return claim;
}

export function domainRoutes(api: Hono<AppEnv>, d: DomainRouteDeps): void {
  // What anyone deploying may choose from, and the org's own claims.
  api.get("/domains", requirePermission("previews.read", "previews.read_own"), (c) =>
    c.json({
      control: d.registry.control(),
      defaultDomain: d.registry.defaultDomain(),
      available: d.registry.availableTo(null),
      domains: domainsOf(d, { kind: "org" }),
    }),
  );

  api.post("/domains", requirePermission("domains.manage"), async (c) => {
    const req = DomainClaimSchema.parse(await readJson(c));
    return c.json({ domain: claimDomain(d, c.get("actor"), { kind: "org" }, req) }, 201);
  });

  api.delete("/domains/:id", requirePermission(...ANY), (c) => {
    removeDomain(d, c.get("actor"), claimOf(d, c.req.param("id")));
    return c.body(null, 204);
  });

  api.post("/domains/:id/check", requirePermission(...ANY), async (c) => {
    const claim = claimOf(d, c.req.param("id"));
    const actor = c.get("actor");
    assertMayManage(d, actor, targetOf(claim), claim.previewId);
    return c.json({ domain: await checkDomain(d, claim, actor) });
  });

  projectDomainRoutes(api, d);
  previewDomainRoutes(api, d);
}

function projectDomainRoutes(api: Hono<AppEnv>, d: DomainRouteDeps): void {
  api.get("/projects/:ref/domains", requirePermission("previews.read"), (c) => {
    const project = projectOf(d, c.req.param("ref"));
    return c.json({
      available: d.registry.availableTo(project.id),
      domains: domainsOf(d, { kind: "project", project }),
    });
  });

  api.post("/projects/:ref/domains", requirePermission("repos.domains"), async (c) => {
    const project = projectOf(d, c.req.param("ref"));
    const req = DomainClaimSchema.parse(await readJson(c));
    const domain = claimDomain(d, c.get("actor"), { kind: "project", project }, req);
    return c.json({ domain }, 201);
  });

  api.put("/projects/:ref/production", requirePermission("repos.domains"), async (c) => {
    const project = projectOf(d, c.req.param("ref"));
    const { previewId } = ProductionChangeSchema.parse(await readJson(c));
    if (previewId !== null) {
      const p = previewOf(d, c.get("actor"), previewId);
      if (p.projectId !== project.id) {
        throw unprocessable(`preview ${previewId} is not one of ${project.slug}'s previews`);
      }
    }
    const after = d.projects.update(project.id, { productionPreviewId: previewId });
    if (!after) {
      throw notFound(`no such project: ${project.slug}`);
    }
    d.audit.record(c.get("actor"), "project.production", project.id, {
      old: project.productionPreviewId,
      new: previewId,
    });
    if (previewId !== null) {
      keepForProduction(d, c.get("actor"), previewId);
    }
    d.registry.refresh();
    return c.json({ project: after });
  });
}

function previewDomainRoutes(api: Hono<AppEnv>, d: DomainRouteDeps): void {
  api.get("/previews/:id/domains", requirePermission("previews.read", "previews.read_own"), (c) => {
    const preview = previewOf(d, c.get("actor"), c.req.param("id"));
    return c.json({
      available: d.registry.availableTo(preview.projectId),
      current: d.registry.domainOf(preview),
      domains: domainsOf(d, { kind: "preview", preview }),
    });
  });

  api.post("/previews/:id/domains", requirePermission("previews.domain"), async (c) => {
    const preview = previewOf(d, c.get("actor"), c.req.param("id"));
    const { name } = DomainClaimForPreviewSchema.parse(await readJson(c));
    const domain = claimDomain(
      d,
      c.get("actor"),
      { kind: "preview", preview },
      {
        name,
        kind: "exact",
      },
    );
    return c.json({ domain }, 201);
  });
}
