import { describe, expect, test } from "bun:test";
import type { Host } from "@gangway/shared/domain";
import { OrgsRepo } from "../../src/db/repos/orgs.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { sleepPreview } from "../../src/previews/sleep.ts";
import { place, type HostLoad } from "../../src/scheduler/placement.ts";
import { setupPreviewContext } from "../helpers/preview-context.ts";

const MIB = 1024 * 1024;

function capped(capacity: Host["capacity"]) {
  const s = setupPreviewContext();
  const local = s.hosts.get("local")!;
  s.hosts.upsert({ ...local, capacity });
  s.ctx.limits = () => ({ memoryBytes: 512 * MIB, cpus: 0, pids: 0, containers: 0 });
  return s;
}

const reserved = (s: ReturnType<typeof setupPreviewContext>, id: string) =>
  (s.db.get("SELECT reserved_bytes AS n FROM previews WHERE id = $id", { id }) as { n: number }).n;

describe("host capacity", () => {
  test("a preview reserves its memory limit, and a full host refuses the next", async () => {
    const s = capped({ memoryBytes: 1024 * MIB, maxPreviews: null });
    const a = await s.deployed("a");
    await s.deployed("b");
    expect(reserved(s, a.id)).toBe(512 * MIB);
    await expect(deploy(s.ctx, s.request("c"))).rejects.toMatchObject({ code: "unavailable" });
    expect(s.previews.list().map((p) => p.project)).toHaveLength(2);
  });

  test("an asleep preview frees its memory but still counts toward maxPreviews", async () => {
    const s = capped({ memoryBytes: 1024 * MIB, maxPreviews: 3 });
    const a = await s.deployed("a");
    await s.deployed("b");
    await sleepPreview(s.ctx, a.id, "idle");
    await s.deployed("c");
    expect(s.previews.hostLoads().get("local")).toEqual({ previews: 3, awakeBytes: 1024 * MIB });
    await expect(deploy(s.ctx, s.request("d"))).rejects.toMatchObject({ code: "unavailable" });
  });

  test("loads count every org's previews and leave out destroyed ones", async () => {
    const s = capped({ memoryBytes: null, maxPreviews: null });
    new OrgsRepo(s.db).create({ id: "org-b", slug: "bee", name: "Bee" });
    const a = await s.deployed("a");
    const b = await s.deployed("b");
    s.db.run("UPDATE previews SET org_id = 'org-b' WHERE id = $id", { id: b.id });
    expect(s.previews.hostLoads().get("local")).toEqual({ previews: 2, awakeBytes: 1024 * MIB });
    s.previews.setState(a.id, "destroyed");
    expect(s.previews.hostLoads().get("local")).toEqual({ previews: 1, awakeBytes: 512 * MIB });
  });
});

describe("placement by load", () => {
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
    capacity: { memoryBytes: 4096 * MIB, maxPreviews: 10 },
    draining: false,
    state: "ready",
    lastError: null,
    lastSeenAt: null,
    createdAt: new Date(0),
    ...o,
  });
  const load = (previews: number, awakeMib: number): HostLoad => ({
    previews,
    awakeBytes: awakeMib * MIB,
  });

  test("the host with the most memory free takes the next preview", () => {
    const hosts = [host("a"), host("b"), host("c")];
    const loads = new Map([
      ["a", load(4, 3072)],
      ["b", load(2, 1024)],
      ["c", load(3, 2048)],
    ]);
    expect(place({ capability: "preview", reserveBytes: 512 * MIB }, hosts, loads).id).toBe("b");
  });

  test("a full host comes after one with room, even one not probed yet", () => {
    const hosts = [host("full"), host("fresh", { state: "unknown" })];
    const loads = new Map([["full", load(10, 0)]]);
    expect(place({ capability: "preview" }, hosts, loads).id).toBe("fresh");
  });

  test("an org's own host comes before a shared one with more room", () => {
    const hosts = [host("shared"), host("mine", { orgId: "a" })];
    const loads = new Map([["mine", load(5, 3072)]]);
    expect(place({ capability: "preview", orgId: "a" }, hosts, loads).id).toBe("mine");
  });

  test("with every host full it still names one, and the claim refuses", () => {
    const hosts = [host("a"), host("b")];
    const loads = new Map([
      ["a", load(10, 0)],
      ["b", load(10, 0)],
    ]);
    expect(place({ capability: "preview" }, hosts, loads).id).toBe("a");
  });
});
