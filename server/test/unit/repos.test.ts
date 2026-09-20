import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase as openBun } from "../../src/db/sqlite.ts";
import { openDatabase as openNode } from "../../src/db/sqlite.node.ts";
import type { Db, OpenOptions } from "../../src/db/types.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
  CertificatesRepo, EventsRepo, HostsRepo, PreviewsRepo, RoutesRepo, SqliteSettingsStore,
} from "../../src/db/repos/index.ts";
import { SETTINGS, Settings } from "../../src/settings.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const DRIVERS: [string, (o: OpenOptions) => { db: Db }][] = [["bun", openBun], ["node", openNode]];

const HOST = {
  id: "local", name: "local", dockerHost: "unix:///var/run/docker.sock", expectName: null,
  capabilities: ["preview" as const], publishBind: "127.0.0.1",
  upstream: { dial: "direct" as const, address: "127.0.0.1", proxy: null },
  ports: { rangeStart: 31000, rangeEnd: 31499 },
};

for (const [name, open] of DRIVERS) {
  describe(`repos (${name})`, () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;

    const setup = () => {
      const d = mkdtempSync(join(tmpdir(), "gangway-repo-"));
      tmps.push(d);
      const { db } = open({ path: join(d, "g.db") });
      migrate(db, MIGRATIONS, now);
      return {
        db,
        hosts: new HostsRepo(db, now),
        previews: new PreviewsRepo(db, now),
        routes: new RoutesRepo(db, now),
        events: new EventsRepo(db, now),
        certs: new CertificatesRepo(db, now),
      };
    };

    const seeded = () => {
      const s = setup();
      s.hosts.upsert(HOST);
      return s;
    };

    test("host upsert is idempotent and round-trips the upstream shape", () => {
      const { hosts } = setup();
      const a = hosts.upsert(HOST);
      expect(a.upstream).toEqual({ dial: "direct", address: "127.0.0.1", proxy: null });
      expect(a.capabilities).toEqual(["preview"]);

      // Re-seeding from config on every boot must not fail, and must apply changes.
      const b = hosts.upsert({ ...HOST, upstream: { dial: "socks5", address: "127.0.0.1", proxy: "socks5://127.0.0.1:1080" } });
      expect(hosts.list()).toHaveLength(1);
      expect(b.upstream.dial).toBe("socks5");
      expect(b.upstream.proxy).toBe("socks5://127.0.0.1:1080");
      expect(b.createdAt).toEqual(a.createdAt);

    });

    test("host state tracks reachability and only stamps last_seen on ready", () => {
      const { hosts } = setup();
      hosts.upsert(HOST);
      hosts.setState("local", "unreachable", "tunnel down");
      let h = hosts.get("local")!;
      expect(h.state).toBe("unreachable");
      expect(h.lastError).toBe("tunnel down");
      expect(h.lastSeenAt).toBeNull();

      hosts.setState("local", "ready");
      h = hosts.get("local")!;
      expect(h.state).toBe("ready");
      expect(h.lastError).toBeNull();
      expect(h.lastSeenAt).toEqual(new Date(clock));
    });

    test("preview create round-trips a discriminated source", () => {
      const { previews } = seeded();
      const p = previews.create({
        id: "p1", project: "gw-acme-pr-1", hostId: "local", state: "building",
        source: { kind: "pr", repo: "acme/web", number: 1, sha: "abc123" },
        visibility: "unlisted",
      });
      expect(p.source).toEqual({ kind: "pr", repo: "acme/web", number: 1, sha: "abc123" });
      expect(p.kind).toBe("preview");
      expect(previews.getByProject("gw-acme-pr-1")!.id).toBe("p1");
    });

    test("touch does not disturb updated_at", () => {
      // last_seen_at means "someone visited"; updated_at means "the lifecycle changed".
      const { previews } = seeded();
      previews.create({ id: "p1", project: "gw-1", hostId: "local", state: "awake",
        source: { kind: "image", image: "nginx" }, visibility: "public" });
      const before = previews.get("p1")!.updatedAt;
      clock += 60_000;
      previews.touch("p1");
      const after = previews.get("p1")!;
      expect(after.updatedAt).toEqual(before);
      expect(after.lastSeenAt).toEqual(new Date(clock));
    });

    test("setState stamps destroyed_at only on destroyed", () => {
      const { previews } = seeded();
      previews.create({ id: "p1", project: "gw-1", hostId: "local", state: "building",
        source: { kind: "image", image: "nginx" }, visibility: "public" });
      previews.setState("p1", "failed", "build exploded");
      expect(previews.get("p1")!.destroyedAt).toBeNull();
      expect(previews.get("p1")!.error).toBe("build exploded");
      previews.setState("p1", "destroyed");
      expect(previews.get("p1")!.destroyedAt).toEqual(new Date(clock));
    });

    test("expired() ignores already-destroyed previews", () => {
      const { previews } = seeded();
      previews.create({ id: "live", project: "gw-a", hostId: "local", state: "awake",
        source: { kind: "image", image: "x" }, visibility: "public", ttlExpiresAt: new Date(clock - 1) });
      previews.create({ id: "gone", project: "gw-b", hostId: "local", state: "awake",
        source: { kind: "image", image: "x" }, visibility: "public", ttlExpiresAt: new Date(clock - 1) });
      previews.setState("gone", "destroyed");
      previews.create({ id: "future", project: "gw-c", hostId: "local", state: "awake",
        source: { kind: "image", image: "x" }, visibility: "public", ttlExpiresAt: new Date(clock + 60_000) });
      expect(previews.expired().map((p) => p.id)).toEqual(["live"]);
    });

    test("idleSince falls back to created_at when never visited", () => {
      const { previews } = seeded();
      previews.create({ id: "never", project: "gw-a", hostId: "local", state: "awake",
        source: { kind: "image", image: "x" }, visibility: "public" });
      previews.create({ id: "recent", project: "gw-b", hostId: "local", state: "awake",
        source: { kind: "image", image: "x" }, visibility: "public" });
      clock += 10_000;
      previews.touch("recent");
      expect(previews.idleSince(clock - 5_000).map((p) => p.id)).toEqual(["never"]);
    });

    test("routes: collisions are constraint violations, and the table is the port ledger", () => {
      const { previews, routes } = seeded();
      previews.create({ id: "p1", project: "gw-1", hostId: "local", state: "building",
        source: { kind: "image", image: "x" }, visibility: "public" });
      routes.create({ hostname: "a.test", previewId: "p1", service: "web", containerPort: 3000,
        upstream: { host: "127.0.0.1", port: 31000 }, primary: true });

      expect(() => routes.create({ hostname: "a.test", previewId: "p1", service: "api",
        containerPort: 4000, upstream: { host: "127.0.0.1", port: 31001 } })).toThrow();
      expect(() => routes.create({ hostname: "b.test", previewId: "p1", service: "api",
        containerPort: 4000, upstream: { host: "127.0.0.1", port: 31000 } })).toThrow();

      routes.create({ hostname: "b.test", previewId: "p1", service: "api", containerPort: 4000,
        upstream: { host: "127.0.0.1", port: 31001 } });
      expect(routes.usedPorts("127.0.0.1")).toEqual(new Set([31000, 31001]));
      // a different host has its own independent pool
      expect(routes.usedPorts("10.0.0.9").size).toBe(0);

      // primary sorts first
      expect(routes.forPreview("p1").map((r) => r.service)).toEqual(["web", "api"]);
    });

    test("updateUpstream handles a container that came back on a new port", () => {
      const { previews, routes } = seeded();
      previews.create({ id: "p1", project: "gw-1", hostId: "local", state: "awake",
        source: { kind: "image", image: "x" }, visibility: "public" });
      routes.create({ hostname: "a.test", previewId: "p1", service: "web", containerPort: 3000,
        upstream: { host: "127.0.0.1", port: 31000 } });
      routes.updateUpstream("a.test", { host: "127.0.0.1", port: 31099 });
      expect(routes.get("a.test")!.upstream.port).toBe(31099);
    });

    test("destroying a preview cascades its routes", () => {
      const { previews, routes } = seeded();
      previews.create({ id: "p1", project: "gw-1", hostId: "local", state: "awake",
        source: { kind: "image", image: "x" }, visibility: "public" });
      routes.create({ hostname: "a.test", previewId: "p1", service: "web", containerPort: 3000,
        upstream: { host: "127.0.0.1", port: 31000 } });
      previews.delete("p1");
      expect(routes.all()).toHaveLength(0);
    });

    test("events give a monotonic replay cursor", () => {
      const { previews, events } = seeded();
      previews.create({ id: "p1", project: "gw-1", hostId: "local", state: "building",
        source: { kind: "image", image: "x" }, visibility: "public" });
      const a = events.append("preview.created", { id: "p1" }, "p1");
      const b = events.append("build.log", { line: "step 1" }, "p1");
      events.append("host.ready", { hostId: "local" });

      expect(b.seq).toBeGreaterThan(a.seq);
      expect(events.latestSeq()).toBe(b.seq + 1);
      expect(events.since(a.seq).map((e) => e.type)).toEqual(["build.log", "host.ready"]);
      expect(events.since(0, 200, "p1").map((e) => e.type)).toEqual(["preview.created", "build.log"]);
      expect(events.since(a.seq, 1)).toHaveLength(1);
      expect(a.payload).toEqual({ id: "p1" });
    });

    test("certificates round-trip and drive renewal timing", () => {
      const { certs } = seeded();
      expect(certs.isDueForRenewal("*.preview.test", 30 * 86400_000)).toBe(true); // missing
      certs.put({
        domain: "*.preview.test", certPem: "CERT", keyPem: "KEY", chainPem: null,
        issuer: "(STAGING) Pretend Pear X1",
        notBefore: new Date(clock), notAfter: new Date(clock + 90 * 86400_000),
      });
      const c = certs.get("*.preview.test")!;
      expect(c.issuer).toContain("STAGING");
      expect(certs.isDueForRenewal("*.preview.test", 30 * 86400_000)).toBe(false);
      expect(certs.isDueForRenewal("*.preview.test", 120 * 86400_000)).toBe(true);
    });

    test("settings store backs the precedence resolver end to end", () => {
      const { db } = setup();
      const store = new SqliteSettingsStore(db, now);
      const settings = new Settings({}, store);
      expect(settings.get(SETTINGS.surfacesMcp)).toBe(false);
      settings.set(SETTINGS.surfacesMcp, true);
      expect(settings.effective(SETTINGS.surfacesMcp).source).toBe("database");

      // A fresh resolver with a config override reads the same store but config wins.
      const pinned = new Settings({ "surfaces.mcp": false }, store);
      expect(pinned.get(SETTINGS.surfacesMcp)).toBe(false);
      expect(pinned.effective(SETTINGS.surfacesMcp).managedByConfig).toBe(true);
      // ...and the stored value survives underneath
      expect(store.get("surfaces.mcp")).toBe(true);
    });
  });
}
