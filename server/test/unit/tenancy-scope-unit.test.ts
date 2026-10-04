import { describe, expect, test } from "bun:test";
import type { GangwayEvent } from "@gangway/shared/domain";
import { EventsRepo } from "../../src/db/repos/events.ts";
import { AuditRepo } from "../../src/db/repos/audit.ts";
import { Audit } from "../../src/audit/audit.ts";
import { silentLogger } from "../helpers/logger.ts";
import { EventBus } from "../../src/events/bus.ts";
import { acrossOrgs, beforeOrg, orgFilter, orgScope, withOrg } from "../../src/tenancy/scope.ts";
import { tempDb } from "../helpers/db.ts";
import { ALL_PERMISSIONS } from "@gangway/shared/permissions";
import { RolePermissions } from "../../src/auth/roles.ts";
import { HOME_ORG_ID, OrgsRepo } from "../../src/db/repos/orgs.ts";
import { RolesRepo } from "../../src/db/repos/roles.ts";
import { TemplatesRepo } from "../../src/db/repos/templates.ts";
import { tokenActor } from "../../src/auth/actor.ts";
import { createOrg } from "../../src/tenancy/orgs.ts";

describe("the org a piece of work runs as", () => {
  test("background work spans every org; a request runs as the org it named", async () => {
    expect(orgScope()).toBe("fleet");
    expect(orgFilter()).toEqual({ sql: "1", params: {} });
    await withOrg("o1", async () => {
      await Bun.sleep(1);
      expect(orgScope()).toEqual({ org: "o1" });
      expect(orgFilter("p.org_id")).toEqual({ sql: "p.org_id = $org", params: { org: "o1" } });
      expect(acrossOrgs(() => orgScope())).toBe("fleet");
    });
  });

  test("a request that has not named its org yet reads nothing org-scoped", () => {
    beforeOrg(() => {
      expect(() => orgScope()).toThrow("before the request named its org");
      expect(withOrg("o2", () => orgScope())).toEqual({ org: "o2" });
    });
  });
});

test("an org's events reach only it; the server's own reach only the home org", () => {
  const { db } = tempDb();
  db.run(
    "INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ('o2', 'two', 'Two', 1, 1)",
  );
  const bus = new EventBus(new EventsRepo(db));
  withOrg("o2", () => bus.publish("before", {}));
  const seen = { home: [] as string[], two: [] as string[] };
  const into = (list: string[]) => (e: GangwayEvent) => list.push(e.type);
  const stops = [
    withOrg(HOME_ORG_ID, () => bus.follow(0, into(seen.home))),
    withOrg("o2", () => bus.follow(0, into(seen.two))),
  ];
  withOrg("o2", () => bus.publish("theirs", {}));
  withOrg(HOME_ORG_ID, () => bus.publish("ours", {}));
  bus.publish("server", {});
  stops.forEach((stop) => stop());
  expect(seen.home).toEqual(["ours", "server"]);
  expect(seen.two).toEqual(["before", "theirs"]);
});

test("an entry with no actor belongs to the org its work runs as, else to the server", () => {
  const { db } = tempDb();
  db.run(
    "INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ('o2', 'two', 'Two', 1, 1)",
  );
  const audit = new Audit(new AuditRepo(db), silentLogger());
  withOrg("o2", () => audit.record(null, "domain.verified", "d1"));
  audit.record(null, "settings.changed", null);
  beforeOrg(() => audit.record(null, "auth.login.failed", null));
  expect(db.query("SELECT action, org_id FROM audit ORDER BY seq")).toEqual([
    { action: "domain.verified", org_id: "o2" },
    { action: "settings.changed", org_id: null },
    { action: "auth.login.failed", org_id: null },
  ]);
});

test("a new org's builtin roles copy home's; its admin holds everything", () => {
  const { db } = tempDb();
  const roles = new RolesRepo(db);
  const permissions = new RolePermissions(roles);
  const audit = new Audit(new AuditRepo(db), silentLogger());
  const deps = {
    db,
    orgs: new OrgsRepo(db),
    roles,
    templates: new TemplatesRepo(db),
    permissions,
    audit,
  };
  const org = createOrg(deps, tokenActor("env:admin", ["admin"], HOME_ORG_ID), {
    slug: "two",
    name: "Two",
  });
  const copies = db.query("SELECT id, kind FROM roles WHERE org_id = $o ORDER BY kind", {
    o: org.id,
  }) as { id: string; kind: string }[];
  expect(copies.map((r) => r.kind)).toEqual(["admin", "member", "viewer"]);
  const [admin, member] = copies;
  expect(permissions.for(admin!.id).size).toBe(ALL_PERMISSIONS.length);
  expect([...permissions.for(member!.id)].sort()).toEqual([...permissions.for("member")].sort());
  expect(withOrg(org.id, () => deps.templates.default().id)).toBe(`d${org.id.toLowerCase()}`);
});
