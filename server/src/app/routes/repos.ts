import type { Hono } from "hono";
import { RepoEnvPatchSchema, RepoPatchSchema } from "../../../../shared/src/api.ts";
import type { AuditSink } from "../../audit/audit.ts";
import type { ReposRepo } from "../../db/repos/repos.ts";
import { badRequest, conflict, notFound, unprocessable } from "../../errors.ts";
import type { RepoEnv } from "../../secrets/repo-env.ts";
import { parseDuration } from "../../util/duration.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

/**
 * `/v1/repos` (ADR-0011): the repositories pull requests have arrived from, and the
 * per-repository knobs. Rows are made by webhooks; here they are read, tuned, or
 * forgotten (the next webhook makes a fresh one).
 */
export function repoRoutes(api: Hono<AppEnv>, repos: ReposRepo, audit: AuditSink, env?: RepoEnv): void {
  api.get("/repos", requirePermission("previews.read"), (c) => c.json({ repos: repos.list() }));

  api.get("/repos/:id", requirePermission("previews.read"), (c) => {
    const repo = repos.get(c.req.param("id"));
    if (!repo) throw notFound(`no such repository: ${c.req.param("id")}`);
    return c.json({ repo });
  });

  api.patch("/repos/:id", requirePermission("github.manage"), async (c) => {
    const id = c.req.param("id");
    const before = repos.get(id);
    if (!before) throw notFound(`no such repository: ${id}`);
    const body = await c.req.json().catch(() => { throw badRequest("the request body is not JSON"); });
    const patch = RepoPatchSchema.parse(body);
    if (patch.ttl !== undefined && patch.ttl !== null && parseDuration(patch.ttl) === null) throw unprocessable(`ttl ${JSON.stringify(patch.ttl)} is not a duration like 12h or 7d`);
    if (patch.slug !== undefined && patch.slug !== before.slug) {
      const taken = repos.getBySlug(patch.slug);
      if (taken) throw conflict(`slug "${patch.slug}" is taken by ${taken.fullName}`, { takenBy: taken.fullName });
    }
    // Enabling clears the reason it was disabled for; the operator has resolved it.
    const after = repos.update(id, { ...patch, ...(patch.enabled === true ? { disabledReason: null } : {}) })!;
    audit.record(c.get("actor"), "repo.updated", id, { old: pick(before), new: pick(after) });
    return c.json({ repo: after });
  });

  // ADR-0012: names in, names out. `repos.secrets` is its own authority.
  api.get("/repos/:id/env", requirePermission("repos.secrets"), (c) => {
    const repo = repos.get(c.req.param("id"));
    if (!repo) throw notFound(`no such repository: ${c.req.param("id")}`);
    return c.json({ names: env ? env.names(repo.id) : [] });
  });

  api.patch("/repos/:id/env", requirePermission("repos.secrets"), async (c) => {
    const repo = repos.get(c.req.param("id"));
    if (!repo) throw notFound(`no such repository: ${c.req.param("id")}`);
    if (!env) throw notFound("secrets are not available on this server");
    const body = await c.req.json().catch(() => { throw badRequest("the request body is not JSON"); });
    const patch = RepoEnvPatchSchema.parse(body);
    const names = env.update(c.get("actor"), repo, patch);
    return c.json({ names });
  });

  api.delete("/repos/:id", requirePermission("github.manage"), (c) => {
    const id = c.req.param("id");
    const before = repos.get(id);
    if (!before) throw notFound(`no such repository: ${id}`);
    repos.delete(id);
    audit.record(c.get("actor"), "repo.deleted", id, { old: pick(before), new: null });
    return c.body(null, 204);
  });
}

const pick = (r: { fullName: string; slug: string; enabled: boolean; visibility: unknown; ttl: unknown; forks: string; drafts: boolean }) =>
  ({ fullName: r.fullName, slug: r.slug, enabled: r.enabled, visibility: r.visibility, ttl: r.ttl, forks: r.forks, drafts: r.drafts });
