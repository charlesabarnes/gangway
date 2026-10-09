import type { Hono } from "hono";
import { servedByGangway, type Preview } from "@gangway/shared/domain";
import type { OrgOverview } from "@gangway/shared/orgs-api";
import type { OrgsRepo } from "../../db/repos/orgs.ts";
import type { UsersRepo } from "../../db/repos/users.ts";
import { notFound } from "../../errors.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export type OrgRouteDeps = {
  orgs: Pick<OrgsRepo, "get" | "limitsOf">;
  users: Pick<UsersRepo, "membersOf">;
  previews: { list(): Preview[] };
  bytesUsed: (orgId: string) => number;
  billingUrl: () => string;
};

const live = (p: Preview) => !["failed", "destroying", "destroyed"].includes(p.state);

/** The credential's own org, never one named in the URL: no id to guess. */
export function orgRoutes(api: Hono<AppEnv>, d: OrgRouteDeps): void {
  api.get("/org", requirePermission("org.read"), (c) => {
    const { orgId } = c.get("actor");
    const org = d.orgs.get(orgId);
    if (!org) {
      throw notFound("no such org");
    }
    const mine = d.previews.list().filter((p) => p.orgId === orgId && live(p));
    const sites = mine.filter(servedByGangway).length;
    const limits = d.orgs.limitsOf(orgId);
    const body: OrgOverview = {
      org: { id: org.id, slug: org.slug, name: org.name, home: org.home, state: org.state },
      planLabel: limits?.planLabel ?? null,
      limits: limits?.limits ?? null,
      usage: {
        sites,
        apps: mine.length - sites,
        storageBytes: d.bytesUsed(orgId),
        members: d.users.membersOf(orgId).length,
      },
      billingUrl: d.billingUrl() || null,
    };
    return c.json(body);
  });

  api.get("/org/members", requirePermission("org.read"), (c) =>
    c.json({ members: d.users.membersOf(c.get("actor").orgId) }),
  );
}
