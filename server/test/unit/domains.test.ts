import { describe, expect, test } from "bun:test";
import type { Actor } from "../../src/auth/actor.ts";
import { DomainsRepo, ProjectsRepo, RoutesRepo } from "../../src/db/repos/index.ts";
import { DomainRegistry } from "../../src/domains/registry.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { urlsFor } from "../../src/previews/deploy-names.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { setPreviewDomain } from "../../src/previews/domain.ts";
import { fixedPolicy, type Policy } from "../../src/previews/policy.ts";
import { RouteTable } from "../../src/routing/table.ts";
import { MemorySettingsStore, Settings } from "../../src/settings.ts";
import { tempDb } from "../helpers/db.ts";
import { seededHosts } from "../helpers/hosts.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { edit, setupRuntimes, tarball } from "../helpers/runtimes-fixtures.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";

const CONTROL = "gw.test";
const DEFAULT = "preview.test";

function registry(db: ReturnType<typeof tempDb>["db"], pinned: string[] = ["alt.test"]) {
  const settings = new Settings(
    { baseDomain: CONTROL, previewDomain: DEFAULT },
    new MemorySettingsStore(),
  );
  const domains = new DomainsRepo(db);
  const projects = new ProjectsRepo(db);
  return {
    registry: new DomainRegistry({ settings, domains, projects, pinned }),
    domains,
    projects,
  };
}

/** An active claim, as the verify job would leave it. */
function claimed(
  domains: DomainsRepo,
  name: string,
  kind: "wildcard" | "exact",
  owner: { projectId?: string; previewId?: string } = {},
) {
  const d = domains.create({ id: `d-${name}`, name, kind, claimId: `c-${name}`, ...owner });
  domains.recordCheck(d.id, { status: "active", routingOk: true, lastError: null });
  return d;
}

function withProject(
  s: ReturnType<typeof setupPreviewContext>,
  projects: ProjectsRepo,
  id: string,
) {
  const base = fixedPolicy();
  const policy: Policy = {
    resolve: (i) => ({ ...base.resolve(i), project: projects.get(id) }),
    default: base.default,
  };
  s.ctx.policy = policy;
}

const actorWith = (...permissions: string[]): Actor =>
  ({
    kind: "token",
    tokenId: "t",
    scopes: [],
    permissions: new Set(permissions),
    orgId: HOME_ORG_ID,
  }) as Actor;

describe("the registry", () => {
  test("the default, pinned and org domains are open to every project", () => {
    const { db } = tempDb();
    const { registry: r, domains, projects } = registry(db);
    projects.create({ orgId: HOME_ORG_ID, id: "p1", name: "web", slug: "web" });
    claimed(domains, "org.test", "wildcard");
    claimed(domains, "mine.test", "wildcard", { projectId: "p1" });
    domains.create({ id: "pending", name: "later.test", kind: "wildcard", claimId: "c" });
    r.refresh();
    expect(r.availableTo(null)).toEqual([DEFAULT, "alt.test", "org.test"]);
    expect(r.availableTo("p1")).toEqual([DEFAULT, "alt.test", "org.test", "mine.test"]);
    expect(r.wildcards()).toEqual([DEFAULT, "alt.test", "org.test", "mine.test"]);
    expect(() => r.assertAvailable("mine.test", null)).toThrow(/not a domain previews here/);
    expect(() => r.assertAvailable("later.test", "p1")).toThrow(/not a domain previews here/);
  });

  test("a preview's choice wins, then its project's, then the default", () => {
    const { db } = tempDb();
    const { registry: r, domains } = registry(db);
    claimed(domains, "org.test", "wildcard");
    r.refresh();
    const project = { id: "p1", domain: "org.test" };
    expect(r.resolve({ preview: "alt.test", project })).toBe("alt.test");
    expect(r.resolve({ project })).toBe("org.test");
    expect(r.resolve({})).toBe(DEFAULT);
    // A choice that stopped being available falls through instead of failing a rebuild.
    expect(r.resolve({ preview: "gone.test", project: { id: "p1", domain: null } })).toBe(DEFAULT);
  });

  test("refuses nested domains and malformed pinned ones at boot", () => {
    const { db } = tempDb();
    expect(() => registry(db, ["x.preview.test"])).toThrow(/under the preview domain/);
    expect(() => registry(db, ["*.alt.test"])).toThrow(/not a domain name/);
  });

  test("an exact hostname answers for its preview, or for its project's production", () => {
    const { db } = tempDb();
    seededHosts(db);
    const { registry: r, domains, projects } = registry(db);
    projects.create({ orgId: HOME_ORG_ID, id: "p1", name: "web", slug: "web" });
    db.run(
      "INSERT INTO previews (id, project, host_id, state, source_kind, source_json, visibility, created_at, updated_at) VALUES ('v1', 'gw-v1', 'local', 'awake', 'image', '{}', 'public', 1, 1), ('v2', 'gw-v2', 'local', 'awake', 'image', '{}', 'public', 1, 1)",
    );
    claimed(domains, "www.shop.example", "exact", { previewId: "v1" });
    claimed(domains, "client.example", "exact", { projectId: "p1" });
    r.refresh();
    expect(r.aliasTarget("www.shop.example")).toBe("v1");
    expect(r.aliasTarget("client.example")).toBeUndefined();
    projects.update("p1", { productionPreviewId: "v2" });
    r.refresh();
    expect(r.aliasTarget("client.example")).toBe("v2");
    expect(r.aliasesOf("v2")).toEqual(["client.example"]);
  });
});

describe("deploying under a domain", () => {
  function setup() {
    const s = setupPreviewContext();
    const r = registry(s.db);
    s.ctx.domains = r.registry;
    s.ctx.previewDomain = () => r.registry.defaultDomain();
    return { ...s, ...r };
  }

  test("a preview is named under its choice, else its project's, else the default", async () => {
    const s = setup();
    s.projects.create({ orgId: HOME_ORG_ID, id: "p1", name: "web", slug: "web" });
    claimed(s.domains, "org.test", "wildcard");
    s.projects.update("p1", { domain: "org.test" });
    s.registry.refresh();

    await (
      await deploy(s.ctx, { ...s.request("plain") })
    ).done;
    expect(s.table.lookup("plain.preview.test")).toBeDefined();

    withProject(s, s.projects, "p1");
    await (
      await deploy(s.ctx, s.request("follows"))
    ).done;
    expect(s.table.lookup("follows.org.test")).toBeDefined();

    const own = await deploy(s.ctx, { ...s.request("chosen"), domain: "alt.test" });
    await own.done;
    expect(s.table.lookup("chosen.alt.test")).toBeDefined();
    expect(s.previews.get(own.preview.id)!.domain).toBe("alt.test");
  });

  test("a domain the project may not use, or without the permission, is refused", async () => {
    const s = setup();
    await expect(deploy(s.ctx, { ...s.request("x"), domain: "nope.test" })).rejects.toMatchObject({
      code: "unprocessable",
    });
    const limited = actorWith("previews.deploy");
    await expect(
      deploy(s.ctx, { ...s.request("y"), actor: limited, domain: "alt.test" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("changing a preview's domain is audited and waits for the next build", async () => {
    const s = setup();
    const p = await s.deployed("later");
    setPreviewDomain(s.ctx, ACTOR, p.id, "alt.test");
    expect(s.previews.get(p.id)!.domain).toBe("alt.test");
    expect(s.table.lookup("later.preview.test")).toBeDefined();
    const { entries } = s.audit.page({ limit: 5, action: "preview.domain" });
    expect(entries[0]).toMatchObject({ target: p.id, old: null, new: "alt.test" });
    expect(() => setPreviewDomain(s.ctx, actorWith(), p.id, null)).toThrow(/previews.domain/);
  });
});

describe("a rebuild moves the preview to its chosen domain", () => {
  test("same label, new domain, and the stack sees the new URL", async () => {
    const s = setupRuntimes();
    const r = registry(s.db);
    s.ctx.domains = r.registry;
    s.ctx.previewDomain = () => r.registry.defaultDomain();
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      visibility: "public",
      name: "shop",
      source: { kind: "tarball", archive: await tarball({ "index.ts": "v1" }), runtime: "bun" },
    });
    const p = await res.done;
    expect(s.routes.forPreview(p.id).map((x) => x.hostname)).toEqual(["shop.preview.test"]);

    await edit(s, p.id, { "index.ts": "v2" });
    expect(s.routes.forPreview(p.id).map((x) => x.hostname)).toEqual(["shop.preview.test"]);

    setPreviewDomain(s.ctx, ACTOR, p.id, "alt.test");
    const o = await edit(s, p.id, { "index.ts": "v3" });
    expect(o.outcome).toBe("succeeded");
    expect(s.routes.forPreview(p.id).map((x) => x.hostname)).toEqual(["shop.alt.test"]);
    expect(s.table.lookup("shop.preview.test")).toBeUndefined();
    expect(s.table.lookup("shop.alt.test")?.previewId).toBe(p.id);
    expect(JSON.stringify(s.fake.stacks.at(-1))).toContain("https://shop.alt.test:8443");
  }, 10_000);

  test("a name another preview holds stops the move before anything changes", async () => {
    const s = setupPreviewContext();
    s.db.run(
      "INSERT INTO previews (id, project, host_id, state, source_kind, source_json, visibility, created_at, updated_at) VALUES ('p1', 'gw-a', 'local', 'awake', 'image', '{}', 'public', 1, 1), ('p2', 'gw-b', 'local', 'awake', 'image', '{}', 'public', 1, 1)",
    );
    s.table.apply({
      route: {
        hostname: "a.preview.test",
        previewId: "p1",
        service: "web",
        containerPort: 80,
        upstream: { host: "127.0.0.1", port: 31000 },
        primary: true,
        createdAt: new Date(),
      },
      hostId: "local",
      project: "gw-a",
      visibility: "public",
      state: "awake",
    });
    s.table.apply({
      route: {
        hostname: "a.alt.test",
        previewId: "p2",
        service: "web",
        containerPort: 80,
        upstream: { host: "127.0.0.1", port: 31001 },
        primary: true,
        createdAt: new Date(),
      },
      hostId: "local",
      project: "gw-b",
      visibility: "public",
      state: "awake",
    });
    expect(() => s.table.moveToDomain("p1", "alt.test")).toThrow(/already another preview/);
    expect(s.routes.get("a.preview.test")?.previewId).toBe("p1");
  });
});

describe("custom hostnames in the route table", () => {
  test("an alias reads through to the preview's primary route and counts on its own", () => {
    const { db } = tempDb();
    seededHosts(db);
    const aliases = new Map<string, string>();
    const table = new RouteTable(new RoutesRepo(db), (h) => aliases.get(h));
    db.run(
      "INSERT INTO previews (id, project, host_id, state, source_kind, source_json, visibility, created_at, updated_at) VALUES ('p1', 'gw-shop', 'local', 'awake', 'image', '{}', 'public', 1, 1)",
    );
    const seed = (hostname: string, service: string, primary: boolean, port: number) =>
      table.apply({
        route: {
          hostname,
          previewId: "p1",
          service,
          containerPort: 80,
          upstream: { host: "127.0.0.1", port },
          primary,
          createdAt: new Date(),
        },
        hostId: "local",
        project: "gw-shop",
        visibility: "public",
        state: "awake",
      });
    seed("shop-api.preview.test", "api", false, 31001);
    seed("shop.preview.test", "web", true, 31000);
    expect(table.lookup("www.shop.example")).toBeUndefined();

    aliases.set("www.shop.example", "p1");
    const alias = table.lookup("www.shop.example")!;
    expect(alias).toMatchObject({
      hostname: "www.shop.example",
      service: "web",
      upstreamPort: 31000,
    });
    expect(table.lookup("www.shop.example")).toBe(alias);

    table.setVisibility("p1", "private");
    table.updateUpstreamPort("shop.preview.test", 31005);
    expect(alias.visibility).toBe("private");
    expect(alias.upstreamPort).toBe(31005);
    alias.inflight++;
    expect(table.lookup("shop.preview.test")!.inflight).toBe(0);

    table.touch("www.shop.example", 42);
    expect(table.drainSeen().get("p1")).toBe(42);

    table.removePreview("p1");
    expect(table.lookup("www.shop.example")).toBeUndefined();
  });
});

describe("urls and destroy", () => {
  test("a routable custom hostname comes first; destroy lets its claims and pin go", async () => {
    const s = setupPreviewContext();
    const r = registry(s.db);
    s.ctx.domains = r.registry;
    const p = await s.deployed("shop");
    r.projects.create({ orgId: HOME_ORG_ID, id: "p1", name: "web", slug: "web" });
    r.projects.update("p1", { productionPreviewId: p.id });
    claimed(r.domains, "www.shop.example", "exact", { previewId: p.id });
    const waiting = r.domains.create({
      id: "d2",
      name: "shop.example",
      kind: "exact",
      previewId: p.id,
      claimId: "c2",
    });
    r.domains.recordCheck(waiting.id, { status: "active", routingOk: false, lastError: null });
    r.registry.refresh();
    expect(urlsFor(s.ctx, p.id).map((u) => u.url)).toEqual([
      "https://www.shop.example:8443/",
      "https://shop.preview.test:8443/",
    ]);

    // Production keeps its volumes until someone chooses another production preview, or none.
    await expect(destroy(s.ctx, p.id, ACTOR)).rejects.toThrow("this preview is web's production");
    expect(s.ctx.previews.get(p.id)!.state).toBe("awake");
    r.projects.update("p1", { productionPreviewId: null });

    await destroy(s.ctx, p.id, ACTOR);
    expect(r.domains.forPreview(p.id)).toEqual([]);
    expect(r.registry.aliasTarget("www.shop.example")).toBeUndefined();
  });

  test("a production preview never lapses with its TTL", async () => {
    const s = setupPreviewContext();
    const r = registry(s.db);
    const p = await s.deployed("shop");
    const lapsed = s.ctx.now() + 8 * 86_400_000;
    expect(s.ctx.previews.expired(lapsed).map((v) => v.id)).toEqual([p.id]);
    r.projects.create({ orgId: HOME_ORG_ID, id: "p1", name: "web", slug: "web" });
    r.projects.update("p1", { productionPreviewId: p.id });
    expect(s.ctx.previews.expired(lapsed)).toEqual([]);
    expect(s.ctx.previews.productionOf(p.id)).toBe("web");
  });
});
