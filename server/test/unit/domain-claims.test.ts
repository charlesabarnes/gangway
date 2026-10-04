import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { domainRoutes } from "../../src/app/routes/domains.ts";
import type { Actor } from "../../src/auth/actor.ts";
import { DomainsRepo, ProjectsRepo } from "../../src/db/repos/index.ts";
import {
  CLAIM_PATIENCE_MS,
  checkDomain,
  checkDue,
  claimDomain,
  removeDomain,
  type ClaimDeps,
} from "../../src/domains/claims.ts";
import type { ClaimDns } from "../../src/domains/dns-check.ts";
import { DomainRegistry } from "../../src/domains/registry.ts";
import { MemorySettingsStore, Settings } from "../../src/settings.ts";
import { silentLogger } from "../helpers/logger.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";

const CONTROL = "gw.test";
const HERE = "203.0.113.7";

/** Public DNS as a map: CNAMEs by name, addresses by name, `*.x` answering any label under x. */
function fakeDns() {
  const cname = new Map<string, string>();
  const a = new Map<string, string>([[CONTROL, HERE]]);
  const dns: ClaimDns = {
    cnames: async (name) => (cname.has(name) ? [cname.get(name)!] : []),
    addresses: async (name) => {
      const wild = `*.${name.split(".").slice(1).join(".")}`;
      const hit = a.get(name) ?? a.get(wild);
      return hit ? [hit] : [];
    },
  };
  return { dns, cname, a };
}

function setup() {
  const s = setupPreviewContext();
  const settings = new Settings(
    { baseDomain: CONTROL, previewDomain: "preview.test" },
    new MemorySettingsStore(),
  );
  const domains = new DomainsRepo(s.db);
  const projects = new ProjectsRepo(s.db);
  const registry = new DomainRegistry({ settings, domains, projects, pinned: [] });
  s.ctx.domains = registry;
  const fake = fakeDns();
  const clock = { now: Date.now() };
  const deps: ClaimDeps = {
    registry,
    domains,
    previews: s.previews,
    hostnames: () => s.table.hostnames(),
    audit: s.ctx.audit,
    bus: s.ctx.bus,
    dns: fake.dns,
    now: () => clock.now,
  };
  projects.create({ id: "p1", name: "web", slug: "web" });
  return { ...s, deps, registry, domains, projects, fake, clock };
}

const actorWith = (...permissions: string[]): Actor =>
  ({
    kind: "token",
    tokenId: "t",
    scopes: [],
    permissions: new Set(permissions),
    orgId: HOME_ORG_ID,
  }) as Actor;
const ORG = { kind: "org" } as const;

describe("claiming", () => {
  test("says which two records to set", () => {
    const s = setup();
    const d = claimDomain(s.deps, ACTOR, ORG, { name: "previews.client.com", kind: "wildcard" });
    expect(d.status).toBe("pending");
    expect(d.records.map((r) => [r.type, r.name, r.value])).toEqual([
      ["CNAME", "_acme-challenge.previews.client.com", `${d.claimId}.acme.${CONTROL}`],
      ["CNAME", "*.previews.client.com", CONTROL],
    ]);
  });

  test.each<[string, "wildcard" | "exact", RegExp]>([
    ["x.gw.test", "exact", /gangway's own domain/],
    ["shop.preview.test", "exact", /under the preview domain preview.test/],
    ["a.previews.test", "wildcard", /under the preview domain previews.test/],
    ["deep.a.previews.test", "exact", /under the preview domain previews.test/],
  ])("refuses %s (%s)", (name, kind, why) => {
    const s = setup();
    claimDomain(s.deps, ACTOR, ORG, { name: "previews.test", kind: "wildcard" });
    const project = { kind: "project", project: s.projects.get("p1")! } as const;
    expect(() => claimDomain(s.deps, ACTOR, project, { name, kind })).toThrow(why);
  });

  test("a wildcard one label above a claimed hostname would take its name", () => {
    const s = setup();
    const project = s.projects.get("p1")!;
    claimDomain(
      s.deps,
      ACTOR,
      { kind: "project", project },
      { name: "shop.acme.com", kind: "exact" },
    );
    expect(() => claimDomain(s.deps, ACTOR, ORG, { name: "acme.com", kind: "wildcard" })).toThrow(
      /claimed as a hostname/,
    );
    expect(() =>
      claimDomain(
        s.deps,
        ACTOR,
        { kind: "project", project },
        { name: "shop.acme.com", kind: "exact" },
      ),
    ).toThrow(/already claimed/);
  });

  test("each level asks for its own permission; a preview claims hostnames only", async () => {
    const s = setup();
    const project = s.projects.get("p1")!;
    const preview = await s.deployed("shop");
    const both = actorWith("repos.domains", "previews.domain", "previews.update");
    expect(() => claimDomain(s.deps, both, ORG, { name: "org.example", kind: "wildcard" })).toThrow(
      /domains.manage/,
    );
    expect(() =>
      claimDomain(
        s.deps,
        actorWith("domains.manage"),
        { kind: "project", project },
        {
          name: "p.example",
          kind: "wildcard",
        },
      ),
    ).toThrow(/repos.domains/);
    expect(() =>
      claimDomain(
        s.deps,
        both,
        { kind: "preview", preview },
        { name: "x.example", kind: "wildcard" },
      ),
    ).toThrow(/claims hostnames/);
    expect(() =>
      claimDomain(
        s.deps,
        actorWith("previews.domain", "previews.update_own"),
        { kind: "preview", preview },
        {
          name: "www.example.org",
          kind: "exact",
        },
      ),
    ).toThrow(/someone else/);
    const ok = claimDomain(
      s.deps,
      both,
      { kind: "preview", preview },
      {
        name: "www.example.org",
        kind: "exact",
      },
    );
    expect(ok.previewId).toBe(preview.id);
  });
});

describe("checking", () => {
  test("the challenge CNAME makes it active; routing is reported on its own", async () => {
    const s = setup();
    const claim = claimDomain(s.deps, ACTOR, ORG, {
      name: "previews.client.com",
      kind: "wildcard",
    });
    const first = await checkDomain(s.deps, claim);
    expect(first).toMatchObject({ status: "pending", routingOk: false });
    expect(first.lastError).toContain("_acme-challenge.previews.client.com is not yet a CNAME");

    s.fake.cname.set("_acme-challenge.previews.client.com", `${claim.claimId}.acme.${CONTROL}`);
    const owned = await checkDomain(s.deps, claim);
    expect(owned).toMatchObject({ status: "active", routingOk: false });
    expect(owned.lastError).toContain("*.previews.client.com does not resolve to gw.test");
    expect(s.registry.availableTo(null)).toContain("previews.client.com");

    s.fake.a.set("*.previews.client.com", HERE);
    expect(await checkDomain(s.deps, s.domains.get(claim.id)!)).toMatchObject({
      status: "active",
      routingOk: true,
      lastError: null,
    });
    expect(s.audit.page({ limit: 5, action: "domain.verified" }).entries).toHaveLength(1);
  });

  test("a claim that never proves control fails; asking again gives it another week", async () => {
    const s = setup();
    const claim = claimDomain(s.deps, ACTOR, ORG, { name: "late.example", kind: "wildcard" });
    s.clock.now = claim.createdAt.getTime() + CLAIM_PATIENCE_MS + 1;
    expect(await checkDue(s.deps)).toBe(1);
    expect(s.domains.get(claim.id)!.status).toBe("failed");
    expect(await checkDue(s.deps)).toBe(0);
    expect((await checkDomain(s.deps, s.domains.get(claim.id)!, ACTOR)).status).toBe("pending");
  });

  test("an exact hostname routes once its own name resolves here", async () => {
    const s = setup();
    const preview = await s.deployed("shop");
    const claim = claimDomain(
      s.deps,
      ACTOR,
      { kind: "preview", preview },
      {
        name: "www.shop.example",
        kind: "exact",
      },
    );
    s.fake.cname.set("_acme-challenge.www.shop.example", `${claim.claimId}.acme.${CONTROL}`);
    s.fake.a.set("www.shop.example", HERE);
    expect(await checkDomain(s.deps, claim)).toMatchObject({ status: "active", routingOk: true });
    expect(s.registry.aliasTarget("www.shop.example")).toBe(preview.id);
  });
});

describe("removing", () => {
  test("refused while a preview is named under it; the choices go with it", async () => {
    const s = setup();
    const claim = claimDomain(s.deps, ACTOR, ORG, { name: "org.example", kind: "wildcard" });
    s.fake.cname.set("_acme-challenge.org.example", `${claim.claimId}.acme.${CONTROL}`);
    await checkDomain(s.deps, claim);
    const res = await (
      await import("../../src/previews/deploy.ts")
    ).deploy(s.ctx, {
      ...s.request("shop"),
      domain: "org.example",
    });
    await res.done;
    expect(() => removeDomain(s.deps, ACTOR, s.domains.get(claim.id)!)).toThrow(
      /shop.org.example is still named under/,
    );
    s.table.removePreview(res.preview.id);
    s.previews.setDomain(res.preview.id, null);
    s.projects.update("p1", { domain: "org.example" });
    expect(() => removeDomain(s.deps, ACTOR, s.domains.get(claim.id)!)).toThrow(/still chooses/);
    s.projects.update("p1", { domain: null });
    removeDomain(s.deps, ACTOR, s.domains.get(claim.id)!);
    expect(s.domains.get(claim.id)).toBeUndefined();
    expect(s.registry.availableTo(null)).not.toContain("org.example");
  });
});

describe("the routes", () => {
  function api(s: ReturnType<typeof setup>, actor: Actor = ACTOR) {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(silentLogger()));
    app.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", actor);
      return next();
    });
    domainRoutes(app, { ...s.deps, projects: s.projects });
    return app;
  }
  const json = (body: unknown, method = "POST") => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  test("claim, list and check a project's domain", async () => {
    const s = setup();
    const app = api(s);
    const res = await app.request(
      "/projects/web/domains",
      json({ name: "Client.COM.", kind: "exact" }),
    );
    expect(res.status).toBe(201);
    const { domain } = (await res.json()) as { domain: { id: string; name: string } };
    expect(domain.name).toBe("client.com");
    const list = (await (await app.request("/projects/web/domains")).json()) as {
      domains: { name: string }[];
    };
    expect(list.domains.map((d) => d.name)).toEqual(["client.com"]);
    const checked = await app.request(`/domains/${domain.id}/check`, { method: "POST" });
    expect(((await checked.json()) as { domain: { status: string } }).domain.status).toBe(
      "pending",
    );
  });

  test("production is one of the project's own previews", async () => {
    const s = setup();
    const app = api(s);
    const stray = await s.deployed("stray");
    const refused = await app.request(
      "/projects/web/production",
      json({ previewId: stray.id }, "PUT"),
    );
    expect(refused.status).toBe(422);

    s.db.run("UPDATE previews SET project_id = 'p1' WHERE id = $id", { id: stray.id });
    const ok = await app.request("/projects/web/production", json({ previewId: stray.id }, "PUT"));
    expect(ok.status).toBe(200);
    expect(s.projects.get("p1")!.productionPreviewId).toBe(stray.id);
    expect(s.audit.page({ limit: 5, action: "project.production" }).entries).toHaveLength(1);
  });

  test("production drops its TTL: it lives until someone destroys it", async () => {
    const s = setup();
    const app = api(s);
    const p = await s.deployed("shop");
    s.db.run("UPDATE previews SET project_id = 'p1' WHERE id = $id", { id: p.id });
    expect(s.previews.get(p.id)!.ttlExpiresAt).not.toBeNull();
    const ok = await app.request("/projects/web/production", json({ previewId: p.id }, "PUT"));
    expect(ok.status).toBe(200);
    expect(s.previews.get(p.id)!.ttlExpiresAt).toBeNull();
    expect(s.audit.page({ limit: 5, action: "preview.extend" }).entries).toHaveLength(1);
  });
});
