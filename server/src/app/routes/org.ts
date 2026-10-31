import type { Hono } from "hono";
import { servedByGangway, type Preview, type PreviewState } from "@gangway/shared/domain";
import type { OrgOverview } from "@gangway/shared/orgs-api";
import type { OrgsRepo } from "../../db/repos/orgs.ts";
import type { UsersRepo } from "../../db/repos/users.ts";
import { notFound } from "../../errors.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export type OrgRouteDeps = {
  orgs: Pick<OrgsRepo, "get" | "limitsOf">;
  users: Pick<UsersRepo, "membersOf" | "memberCount">;
  previews: { list(f: { state: PreviewState[] }): Preview[] };
  bytesUsed: (orgId: string) => number;
  buildMsUsed: (orgId: string) => number;
  billingUrl: () => string;
};

const LIVE: PreviewState[] = ["building", "starting", "awake", "asleep"];
const AWAKE: PreviewState[] = ["starting", "awake"];

/** The credential's own org, never one named in the URL: no id to guess. */
export function orgRoutes(api: Hono<AppEnv>, d: OrgRouteDeps): void {
  api.get("/org", requirePermission("org.read"), (c) => {
    const { orgId } = c.get("actor");
    const org = d.orgs.get(orgId);
    if (!org) {
      throw notFound("no such org");
    }
    // Already the actor's org alone: a request's scope narrows the query.
    const mine = d.previews.list({ state: LIVE });
    const sites = mine.filter(servedByGangway).length;
    const limits = d.orgs.limitsOf(orgId);
    const body: OrgOverview = {
      org: { id: org.id, slug: org.slug, name: org.name, home: org.home, state: org.state },
      planLabel: limits?.planLabel ?? null,
      limits: limits?.limits ?? null,
      usage: {
        sites,
        apps: mine.length - sites,
        awake: mine.filter((p) => !servedByGangway(p) && AWAKE.includes(p.state)).length,
        storageBytes: d.bytesUsed(orgId),
        members: d.users.memberCount(orgId),
        buildMinutes: Math.ceil(d.buildMsUsed(orgId) / 60_000),
      },
      billingUrl: d.billingUrl() || null,
    };
    return c.json(body);
  });

  api.get("/org/members", requirePermission("org.read"), (c) =>
    c.json({ members: d.users.membersOf(c.get("actor").orgId) }),
  );
}
