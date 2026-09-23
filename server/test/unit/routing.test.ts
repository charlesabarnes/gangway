import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/sqlite.ts";
import { migrate } from "../../src/db/migrate.ts";
import { HostsRepo, PreviewsRepo, RoutesRepo } from "../../src/db/repos/index.ts";
import { RouteTable } from "../../src/routing/table.ts";
import {
  allocatePort,
  allocatePorts,
  assertInRange,
  isInRange,
  PortExhausted,
} from "../../src/routing/ports.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RANGE = { rangeStart: 31000, rangeEnd: 31004 };

describe("port allocator", () => {
  test("takes the lowest free port", () => {
    expect(allocatePort(RANGE, new Set())).toBe(31000);
    expect(allocatePort(RANGE, new Set([31000, 31001]))).toBe(31002);
  });

  test("fills holes left by destroyed previews", () => {
    expect(allocatePort(RANGE, new Set([31000, 31002]))).toBe(31001);
  });

  test("allocatePorts returns distinct ports", () => {
    const ps = allocatePorts(RANGE, new Set([31001]), 3);
    expect(ps).toEqual([31000, 31002, 31003]);
    expect(new Set(ps).size).toBe(3);
  });

  test("throws rather than drifting outside the pool when exhausted", () => {
    const full = new Set([31000, 31001, 31002, 31003, 31004]);
    expect(() => allocatePort(RANGE, full, "docker-host")).toThrow(PortExhausted);
    expect(() => allocatePorts(RANGE, new Set(), 6)).toThrow(PortExhausted);
  });

  test("range guard rejects a port outside the pool", () => {
    expect(isInRange(31000, RANGE)).toBe(true);
    expect(isInRange(30999, RANGE)).toBe(false);
    expect(isInRange(31005, RANGE)).toBe(false);
    expect(() => assertInRange(55433, RANGE, "docker-host")).toThrow(
      /outside host docker-host's pool/,
    );
    expect(() => assertInRange(31002, RANGE)).not.toThrow();
  });

  test("the pool sits below the kernel ephemeral floor", () => {
    // docker-host's ephemeral range starts at 32768; an allocation above it could collide
    // with a port the kernel hands to an unrelated process.
    expect(RANGE.rangeEnd).toBeLessThan(32768);
  });
});

describe("RouteTable", () => {
  const setup = () => {
    const d = mkdtempSync(join(tmpdir(), "gangway-rt-"));
    tmps.push(d);
    const { db } = openDatabase({ path: join(d, "g.db") });
    migrate(db, MIGRATIONS);
    const now = () => 1_700_000_000_000;
    new HostsRepo(db, now).upsert({
      id: "local",
      name: "local",
      dockerHost: "unix:///x",
      expectName: null,
      capabilities: ["preview"],
      publishBind: "127.0.0.1",
      upstream: { dial: "direct", address: "127.0.0.1", proxy: null },
      ports: { rangeStart: 31000, rangeEnd: 31499 },
    });
    const previews = new PreviewsRepo(db, now);
    previews.create({
      id: "p1",
      project: "gw-1",
      hostId: "local",
      state: "building",
      source: { kind: "image", image: "nginx" },
      visibility: "public",
    });
    const routes = new RoutesRepo(db, now);
    return { db, routes, previews, table: new RouteTable(routes) };
  };

  const seed = (hostname: string, port: number, service = "web", previewId = "p1") => ({
    route: {
      hostname,
      previewId,
      service,
      containerPort: 3000,
      upstream: { host: "127.0.0.1", port },
      primary: service === "web",
      createdAt: new Date(0),
    },
    hostId: "local",
    project: "gw-1",
    visibility: "public" as const,
    state: "building" as const,
  });

  test("apply writes through to SQLite and memory", () => {
    const { table, routes } = setup();
    table.apply(seed("a.test", 31000));
    expect(table.lookup("a.test")?.upstreamPort).toBe(31000);
    expect(routes.get("a.test")?.upstream.port).toBe(31000);
  });

  test("a failed database write leaves MEMORY UNTOUCHED", () => {
    // This is the invariant the whole cache design rests on.
    const { table } = setup();
    table.apply(seed("a.test", 31000));
    expect(() => table.apply(seed("a.test", 31001))).toThrow(); // hostname collision
    expect(table.size).toBe(1);
    expect(table.lookup("a.test")!.upstreamPort).toBe(31000); // unchanged
  });

  test("a duplicate upstream port is refused by the database, not silently accepted", () => {
    const { table } = setup();
    table.apply(seed("a.test", 31000));
    expect(() => table.apply(seed("b.test", 31000, "api"))).toThrow();
    expect(table.size).toBe(1);
  });

  test("lookup is exact-match only -- no wildcard, no prefix", () => {
    const { table } = setup();
    table.apply(seed("a.test", 31000));
    expect(table.lookup("a.test")).toBeDefined();
    expect(table.lookup("sub.a.test")).toBeUndefined();
    expect(table.lookup("A.TEST")).toBeUndefined(); // caller normalizes first
  });

  test("hydrate replaces memory without writing the database", () => {
    const { table, routes } = setup();
    table.hydrate([seed("a.test", 31000), seed("b.test", 31001, "api")]);
    expect(table.size).toBe(2);
    expect(routes.all()).toHaveLength(0); // hydrate is read-side only
  });

  test("state and visibility propagate to every route of a preview", () => {
    const { table } = setup();
    table.hydrate([seed("a.test", 31000), seed("b.test", 31001, "api")]);
    table.setState("p1", "awake");
    table.setVisibility("p1", "private");
    for (const h of ["a.test", "b.test"]) {
      expect(table.lookup(h)!.state).toBe("awake");
      expect(table.lookup(h)!.visibility).toBe("private");
    }
  });

  test("forPreview and removePreview cover every route", () => {
    const { table, routes } = setup();
    table.apply(seed("a.test", 31000));
    table.apply(seed("b.test", 31001, "api"));
    expect(table.forPreview("p1")).toHaveLength(2);
    expect(table.removePreview("p1")).toBe(2);
    expect(table.size).toBe(0);
    expect(routes.all()).toHaveLength(0);
    expect(table.forPreview("p1")).toHaveLength(0);
  });

  test("usedPorts reflects memory and is scoped per upstream host", () => {
    const { table } = setup();
    table.apply(seed("a.test", 31000));
    table.apply(seed("b.test", 31001, "api"));
    expect(table.usedPorts("127.0.0.1")).toEqual(new Set([31000, 31001]));
    expect(table.usedPorts("10.0.0.9").size).toBe(0);
  });

  test("allocator and table compose: no port is ever handed out twice", () => {
    const { table } = setup();
    const range = { rangeStart: 31000, rangeEnd: 31002 };
    for (let i = 0; i < 3; i++) {
      const p = allocatePort(range, table.usedPorts("127.0.0.1"));
      table.apply(seed(`h${i}.test`, p, `svc${i}`));
    }
    expect(table.usedPorts("127.0.0.1")).toEqual(new Set([31000, 31001, 31002]));
    expect(() => allocatePort(range, table.usedPorts("127.0.0.1"))).toThrow(PortExhausted);
  });

  test("updateUpstreamPort writes through both layers", () => {
    const { table, routes } = setup();
    table.apply(seed("a.test", 31000));
    table.updateUpstreamPort("a.test", 31099);
    expect(table.lookup("a.test")!.upstreamPort).toBe(31099);
    expect(routes.get("a.test")!.upstream.port).toBe(31099);
  });

  test("evict removes from memory only, leaving the row for the reconciler", () => {
    const { table, routes } = setup();
    table.apply(seed("a.test", 31000));
    table.evict("a.test");
    expect(table.lookup("a.test")).toBeUndefined();
    expect(routes.get("a.test")).toBeDefined();
  });

  test("touch updates the entry used by idle-sleep", () => {
    const { table } = setup();
    table.apply(seed("a.test", 31000));
    table.touch("a.test", 12345);
    expect(table.lookup("a.test")!.lastSeenAt).toBe(12345);
    expect(() => table.touch("nope.test", 1)).not.toThrow();
  });
});
