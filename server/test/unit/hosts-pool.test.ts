import { describe, expect, test } from "bun:test";
import type { Host, Preview } from "@gangway/shared/domain";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { hostRoutes } from "../../src/app/routes/hosts.ts";
import { staticTokenVerifier } from "../../src/auth/actor.ts";
import { HOME_ORG_ID, OrgsRepo } from "../../src/db/repos/orgs.ts";
import { HostConfigSchema } from "../../src/config.ts";
import { retireUnlisted, seedHosts } from "../../src/hosts/seed.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { checkStillThere, place } from "../../src/scheduler/placement.ts";
import { setupPreviewContext } from "../helpers/preview-context.ts";
import { currentOrg } from "../../src/tenancy/scope.ts";
import { seededHosts } from "../helpers/hosts.ts";
import { silentLogger } from "../helpers/logger.ts";
import { tempDb } from "../helpers/db.ts";

const TOKEN = "gw_test_admin_token_0123456789";

const pool = (o: Record<string, unknown> = {}) => ({
  name: "pool-1",
  dockerHost: "ssh://gangway@10.0.0.5",
  capabilities: ["preview"],
  upstream: { address: "10.0.0.5" },
  ports: { rangeStart: 31000, rangeEnd: 31499 },
  ...o,
});

function setup() {
  const { db } = tempDb();
  const hosts = seededHosts(db);
  const orgs = new OrgsRepo(db);
  orgs.create({ id: "org-b", slug: "bee", name: "Bee" });
  const running = new Map<string, Preview[]>();
  const orgsSeen: (string | null)[] = [];
  const audited: string[] = [];
  const app = createApp({
    logger: silentLogger(),
    verifyToken: staticTokenVerifier(TOKEN, HOME_ORG_ID),
    v1: (api) =>
      hostRoutes(api, {
        hosts,
        orgs,
        previews: {
          list: (f) => {
            orgsSeen.push(currentOrg());
            return running.get(f?.hostId ?? "") ?? [];
          },
        },
        audit: { record: (_actor, action) => audited.push(action) },
      }),
  });
  const h = surfaceHandler(app, "api");
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await h(
      new Request(`https://api.preview.localhost/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { clientIp: "::1" },
    );
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, never>) : {} };
  };
  return { hosts, running, orgsSeen, audited, call };
}

describe("hosts API", () => {
  test("PUT registers a host, again changes nothing more, and redacts the target", async () => {
    const { call, hosts, audited } = setup();
    const made = await call(
      "PUT",
      "/hosts/pool-1",
      pool({ dockerHost: "ssh://u:hunter2hunter2@h" }),
    );
    expect(made.status).toBe(201);
    expect(JSON.stringify(made.body)).not.toContain("hunter2");
    expect(made.body["host"]).toMatchObject({
      id: "pool-1",
      managedBy: "api",
      orgId: null,
      draining: false,
      capacity: { memoryBytes: null, maxPreviews: null },
      upstream: { dial: "direct", address: "10.0.0.5", proxy: null },
      runtime: null,
    });
    const again = await call(
      "PUT",
      "/hosts/pool-1",
      pool({ dockerHost: "ssh://u:hunter2hunter2@h" }),
    );
    expect(again.status).toBe(200);
    expect(hosts.list().map((h) => h.id)).toEqual(["local", "pool-1"]);
    expect(audited).toEqual(["host.registered", "host.registered"]);
  });

  test("a short login in the docker host or the proxy never comes back", async () => {
    const { call } = setup();
    const upstream = {
      dial: "socks5",
      address: "10.0.0.5",
      proxy: "socks5://u:p?s#s@w@10.0.0.9:1080",
    };
    const made = await call("PUT", "/hosts/p", pool({ dockerHost: "ssh://u:pw@h", upstream }));
    const listed = await call("GET", "/hosts");
    for (const text of [JSON.stringify(made.body), JSON.stringify(listed.body)]) {
      expect(text).not.toContain("u:p");
      expect(text).not.toContain("w@10");
      expect(text).toContain("socks5://[redacted]@10.0.0.9:1080");
    }
  });

  test("a unix socket path with @ in it is left as it is", async () => {
    const { call } = setup();
    const dockerHost = "unix:///run/user/alice@example/docker.sock";
    const made = await call("PUT", "/hosts/p", pool({ dockerHost }));
    expect(made.body).toMatchObject({ host: { dockerHost } });
  });

  test("a config host, an unknown org, a taken name and bad ports are refused", async () => {
    const { call } = setup();
    expect((await call("PUT", "/hosts/local", pool())).status).toBe(409);
    expect((await call("PUT", "/hosts/p", pool({ orgId: "nope" }))).status).toBe(422);
    expect((await call("PUT", "/hosts/p", pool({ name: "local" }))).status).toBe(409);
    const ports = { rangeStart: 32000, rangeEnd: 31000 };
    expect((await call("PUT", "/hosts/p", pool({ ports }))).status).toBe(422);
    expect((await call("PUT", "/hosts/Bad.Id", pool())).status).toBe(400);
    expect((await call("PUT", "/hosts/p", pool({ runtime: "runc" }))).status).toBe(422);
    const socks = { dial: "socks5", address: "10.0.0.5" };
    expect((await call("PUT", "/hosts/p", pool({ upstream: socks }))).status).toBe(422);
  });

  test("a host is removed only once no preview of any org runs on it", async () => {
    const { call, hosts, running, orgsSeen } = setup();
    await call("PUT", "/hosts/pool-1", pool({ orgId: "org-b" }));
    running.set("pool-1", [{ id: "p1", source: { kind: "image" } } as Preview]);

    const drained = await call("POST", "/hosts/pool-1/drain");
    expect(drained.status).toBe(200);
    expect(drained.body).toMatchObject({ host: { draining: true }, previews: 1 });
    expect((await call("DELETE", "/hosts/pool-1")).status).toBe(409);
    // Counted across every org, not the operator's own.
    expect(orgsSeen.every((o) => o === null)).toBe(true);

    // A site has no container, so it does not keep the host.
    running.set("pool-1", [{ id: "s1", source: { kind: "tarball", serve: "gangway" } } as Preview]);
    expect((await call("DELETE", "/hosts/pool-1")).status).toBe(204);
    expect(hosts.list().map((h) => h.id)).toEqual(["local"]);
    expect(hosts.get("pool-1")).toBeDefined();
    expect((await call("DELETE", "/hosts/pool-1")).status).toBe(404);
    expect((await call("POST", "/hosts/pool-1/drain")).status).toBe(404);
  });

  test("registering a removed host's id again brings it back, not draining", async () => {
    const { call, hosts } = setup();
    await call("PUT", "/hosts/pool-1", pool());
    await call("DELETE", "/hosts/pool-1");
    expect((await call("PUT", "/hosts/pool-1", pool())).status).toBe(200);
    expect(hosts.list().find((h) => h.id === "pool-1")).toMatchObject({ draining: false });
  });

  test("a config host can drain and come back, but not be removed", async () => {
    const { call } = setup();
    expect((await call("POST", "/hosts/local/drain")).body).toMatchObject({
      host: { draining: true },
    });
    expect((await call("DELETE", "/hosts/local")).status).toBe(409);
    expect((await call("DELETE", "/hosts/local/drain")).body).toMatchObject({
      host: { draining: false },
    });
  });
});

describe("hosts in use", () => {
  test("a host running previews keeps where it is and whose, but may be renamed", async () => {
    const { call, running } = setup();
    await call("PUT", "/hosts/pool-1", pool());
    running.set("pool-1", [{ id: "p1", source: { kind: "image" } } as Preview]);
    expect((await call("PUT", "/hosts/pool-1", pool({ dockerHost: "ssh://x@h2" }))).status).toBe(
      409,
    );
    expect((await call("PUT", "/hosts/pool-1", pool({ orgId: "org-b" }))).status).toBe(409);
    expect((await call("PUT", "/hosts/pool-1", pool({ expectName: "other" }))).status).toBe(409);
    expect((await call("PUT", "/hosts/pool-1", pool({ runtime: "runsc" }))).status).toBe(409);
    expect((await call("PUT", "/hosts/pool-1", pool({ name: "pool-one" }))).status).toBe(200);
    running.delete("pool-1");
    expect((await call("PUT", "/hosts/pool-1", pool({ dockerHost: "ssh://x@h2" }))).status).toBe(
      200,
    );
  });

  test("a config id an API host holds is skipped, and unlisted config hosts retire", async () => {
    const { call, hosts } = setup();
    await call("PUT", "/hosts/pool-1", pool());
    const clashes: string[] = [];
    const cfg = (o: Record<string, unknown>) => HostConfigSchema.parse(o);
    seedHosts([cfg({ id: "pool-1", name: "x" }), cfg({ id: "b", name: "b" })], hosts, (id) =>
      clashes.push(id),
    );
    expect(clashes).toEqual(["pool-1"]);
    expect(hosts.get("pool-1")).toMatchObject({
      managedBy: "api",
      dockerHost: "ssh://gangway@10.0.0.5",
    });

    const busy = new Set(["b"]);
    expect(retireUnlisted([], hosts, (id) => busy.has(id))).toEqual({
      removed: ["local"],
      draining: ["b"],
    });
    busy.clear();
    expect(retireUnlisted([], hosts, () => false)).toEqual({ removed: ["b"], draining: [] });
    expect(hosts.list().map((h) => h.id)).toEqual(["pool-1"]);
    // A retired config id may be registered through the API.
    expect((await call("PUT", "/hosts/local", pool({ name: "local" }))).status).toBe(200);
  });

  test("a template's draining host falls back to the scheduler; an explicit pin does not", async () => {
    const s = setupPreviewContext();
    const local = s.hosts.get("local")!;
    s.hosts.upsert({ ...local, id: "spare", name: "spare" });
    s.hosts.setDraining("local", true);
    s.ctx.policy = fixedPolicy({ hostId: "local" });
    expect((await s.deployed("a")).hostId).toBe("spare");
    await expect(deploy(s.ctx, { ...s.request("b"), hostId: "local" })).rejects.toThrow(/draining/);
  });
});

describe("a host chosen before the claim", () => {
  test("must still be in service and unmoved when the preview is claimed", () => {
    const { hosts } = setup();
    const chosen = hosts.get("local")!;
    expect(() => checkStillThere(hosts.list(), chosen)).not.toThrow();
    hosts.setDraining("local", true);
    expect(() => checkStillThere(hosts.list(), chosen)).toThrow(/draining/);
    hosts.setDraining("local", false);
    hosts.upsert({ ...chosen, dockerHost: "ssh://elsewhere" });
    expect(() => checkStillThere(hosts.list(), chosen)).toThrow(/changed/);
    expect(() => checkStillThere([], chosen)).toThrow(/changed/);
  });
});

describe("placement across orgs", () => {
  const host = (id: string, o: Partial<Host> = {}): Host => ({
    id,
    name: id,
    dockerHost: "x",
    expectName: null,
    capabilities: ["preview"],
    publishBind: "127.0.0.1",
    upstream: { dial: "direct", address: "127.0.0.1", proxy: null },
    ports: { rangeStart: 1, rangeEnd: 2 },
    managedBy: "api",
    orgId: null,
    capacity: { memoryBytes: null, maxPreviews: null },
    draining: false,
    runtime: null,
    egress: "open",
    state: "ready",
    lastError: null,
    lastSeenAt: null,
    createdAt: new Date(0),
    ...o,
  });

  test("an org's own host comes first, then a shared one; another org's never", () => {
    const hosts = [host("shared"), host("a-own", { orgId: "a" }), host("b-own", { orgId: "b" })];
    expect(place({ capability: "preview", orgId: "a" }, hosts).id).toBe("a-own");
    expect(place({ capability: "preview", orgId: "c" }, hosts).id).toBe("shared");
    expect(() => place({ capability: "preview", orgId: "a" }, [host("b", { orgId: "b" })])).toThrow(
      /no reachable host/,
    );
  });

  test("pinning another org's host reads as no such host", () => {
    const hosts = [host("shared"), host("b-own", { orgId: "b" })];
    expect(() => place({ capability: "preview", orgId: "a", hostId: "b-own" }, hosts)).toThrow(
      /does not exist/,
    );
  });

  test("a draining host takes nothing new, pinned or not", () => {
    const hosts = [host("old", { draining: true }), host("new", { state: "unknown" })];
    expect(place({ capability: "preview", orgId: "a" }, hosts).id).toBe("new");
    expect(() => place({ capability: "preview", orgId: "a", hostId: "old" }, hosts)).toThrow(
      /draining/,
    );
    expect(() => place({ capability: "preview" }, [host("old", { draining: true })])).toThrow(
      /no reachable host/,
    );
  });
});
