import type { Hono } from "hono";
import { EnvPatchSchema } from "@gangway/shared/api";
import { maySee, type Actor } from "../../auth/actor.ts";
import type { SecretTarget } from "../../auth/secret-access.ts";
import type { ProjectsRepo } from "../../db/repos/projects.ts";
import { notFound } from "../../errors.ts";
import { nameOf } from "../../mcp/resolve.ts";
import type { PreviewContext } from "../../previews/context.ts";
import { readJson } from "../problem.ts";
import { changeSecrets, listSecrets, type SecretChangeDeps } from "../../secrets/change.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

const ORG = { kind: "org" } as const;

export function secretRoutes(api: Hono<AppEnv>, d: SecretChangeDeps): void {
  api.get("/secrets", requirePermission("repos.secrets"), (c) =>
    c.json({ secrets: listSecrets(d, c.get("actor"), ORG) }),
  );

  api.patch("/secrets", requirePermission("repos.secrets"), async (c) => {
    const patch = EnvPatchSchema.parse(await readJson(c));
    return c.json(changeSecrets(d, c.get("actor"), ORG, patch));
  });
}

export type PreviewSecretDeps = SecretChangeDeps & {
  projects: Pick<ProjectsRepo, "get">;
  ctx: Pick<PreviewContext, "previews" | "instance">;
};

/** The secret target for a preview the actor can see; one it cannot answers as not found. */
export function previewTarget(d: PreviewSecretDeps, actor: Actor, id: string): SecretTarget {
  const preview = d.ctx.previews.get(id);
  const provenance = d.ctx.previews.provenanceOf(id);
  if (!preview || preview.state === "destroyed" || !maySee(actor, provenance))
    throw notFound(`no such preview: ${id}`);
  const project = preview.projectId ? (d.projects.get(preview.projectId) ?? null) : null;
  return { kind: "preview", preview, name: nameOf(d.ctx, preview), provenance, project };
}

const SECRETS = ["previews.secrets", "repos.secrets"] as const;

export function previewSecretRoutes(api: Hono<AppEnv>, d: PreviewSecretDeps): void {
  api.get("/previews/:id/env", requirePermission(...SECRETS), (c) => {
    const actor = c.get("actor");
    return c.json({ secrets: listSecrets(d, actor, previewTarget(d, actor, c.req.param("id"))) });
  });

  api.patch("/previews/:id/env", requirePermission(...SECRETS), async (c) => {
    const actor = c.get("actor");
    const target = previewTarget(d, actor, c.req.param("id"));
    const patch = EnvPatchSchema.parse(await readJson(c));
    return c.json(changeSecrets(d, actor, target, patch));
  });
}
