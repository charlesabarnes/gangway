import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { eventRoutes } from "../../src/app/routes/events.ts";
import { hostRoutes } from "../../src/app/routes/hosts.ts";
import { staticTokenVerifier } from "../../src/auth/actor.ts";
import { HostConfigSchema } from "../../src/config.ts";
import { migrate } from "../../src/db/migrate.ts";
import { EventsRepo, HostsRepo } from "../../src/db/repos/index.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { EventBus } from "../../src/events/bus.ts";
import { seedHosts } from "../../src/hosts/seed.ts";
import { Logger } from "../../src/logger.ts";
import { PreviewLogs } from "../../src/previews/logs.ts";
import { place } from "../../src/scheduler/placement.ts";
import { ulid } from "../../src/util/ulid.ts";
import type { GangwayEvent, Host } from "../../../shared/src/domain.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const TOKEN = "gw_test_admin_token_0123456789";
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gangway-events-"));
  tmps.push(dir);
  const { db } = openDatabase({ path: join(dir, "g.db") });
  migrate(db, MIGRATIONS);
  const events = new EventsRepo(db);
  const hosts = new HostsRepo(db);
  const bus = new EventBus(events);
  const app = createApp({
    logger: new Logger("error", {}, () => {}),
    verifyToken: staticTokenVerifier(TOKEN),
    v1: (api) => { eventRoutes(api, bus, { heartbeatMs: 40 }); hostRoutes(api, hosts); },
  });
  const h = surfaceHandler(app, "api");
  const get = (path: string, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    Promise.resolve(h(new Request(`https://api.preview.localhost${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, ...headers }, ...(signal ? { signal } : {}),
    }), { clientIp: "::1" }));
  return { dir, bus, events, hosts, get };
}

/** Reads SSE frames until `count` events (not comments) have arrived. */
async function readFrames(res: Response, count: number, wantComments = false) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: Record<string, string>[] = [];
  let comments = 0;
  while (frames.length < count || (wantComments && comments === 0)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (raw.startsWith(":")) { comments++; continue; }
      frames.push(Object.fromEntries(raw.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()])));
    }
  }
  await reader.cancel();
  return { frames, comments };
}

describe("EventBus", () => {
  test("publish persists, then fans out; a throwing listener does not stop the rest", () => {
    const { bus, events } = setup();
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("bad client"); });
    bus.subscribe((e) => seen.push(e.type));
    const e = bus.publish("preview.state", { state: "building" }, null);
    expect(e.seq).toBe(1);
    expect(seen).toEqual(["preview.state"]);
    expect(events.latestSeq()).toBe(1);
  });

  test("follow: replays the backlog, then goes live, with no gap and no duplicate", () => {
    const { bus } = setup();
    for (let i = 0; i < 450; i++) bus.publish("tick", { i });
    const got: GangwayEvent[] = [];
    const stop = bus.follow(100, (e) => got.push(e));
    expect(got.length).toBe(350);
    bus.publish("tick", { i: 450 });
    expect(got.map((e) => e.seq)).toEqual(Array.from({ length: 351 }, (_, k) => 101 + k));
    stop();
    bus.publish("tick", {});
    expect(got.length).toBe(351);
    expect(bus.listenerCount).toBe(0);
  });

  test("follow: a preview filter applies to backlog and live alike", () => {
    const { bus } = setup();
    // previews has a FK from events; use null vs. a filter that matches nothing.
    bus.publish("a");
    const got: GangwayEvent[] = [];
    bus.follow(0, (e) => got.push(e), "01HZZZZZZZZZZZZZZZZZZZZZZZ");
    bus.publish("b");
    expect(got).toEqual([]);
  });

  test("follow: a client hopelessly behind gets one reset, then live events", () => {
    const { bus } = setup();
    for (let i = 0; i < 1200; i++) bus.publish("tick");
    const got: GangwayEvent[] = [];
    bus.follow(0, (e) => got.push(e));
    expect(got.length).toBe(1001);
    expect(got.at(-1)).toMatchObject({ type: "reset", seq: 1200 });
    bus.publish("after");
    expect(got.at(-1)).toMatchObject({ type: "after", seq: 1201 });
  });
});

describe("GET /v1/events", () => {
  test("requires auth", async () => {
    const { get } = setup();
    expect((await get("/v1/events", { authorization: "" })).status).toBe(401);
  });

  test("streams backlog then live; ids are seqs; Last-Event-ID resumes", async () => {
    const { bus, get } = setup();
    bus.publish("one", { n: 1 });
    bus.publish("two", { n: 2 });
    const res = await get("/v1/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    setTimeout(() => bus.publish("three", { n: 3 }), 10);
    const { frames } = await readFrames(res, 3);
    expect(frames.map((f) => [f["id"], f["event"]])).toEqual([["1", "one"], ["2", "two"], ["3", "three"]]);
    expect(JSON.parse(frames[2]!["data"]!)).toMatchObject({ n: 3, previewId: null });

    const resumed = await readFrames(await get("/v1/events", { "last-event-id": "2" }), 1);
    expect(resumed.frames.map((f) => f["id"])).toEqual(["3"]);
    const viaQuery = await readFrames(await get("/v1/events?after=2"), 1);
    expect(viaQuery.frames.map((f) => f["id"])).toEqual(["3"]);
  });

  test("an idle stream sends keepalive comments, and a disconnect unsubscribes", async () => {
    const { bus, get } = setup();
    bus.publish("one");
    const res = await get("/v1/events");
    const { comments } = await readFrames(res, 1, true);
    expect(comments).toBeGreaterThan(0);
    await Bun.sleep(80);
    expect(bus.listenerCount).toBe(0);
  });
});

describe("hosts (T16)", () => {
  const cfg = (o: Record<string, unknown> = {}) => HostConfigSchema.parse(o);

  test("seeding is idempotent and does not clobber reconciler-owned state", () => {
    const { hosts } = setup();
    seedHosts([cfg()], hosts);
    hosts.setState("local", "unreachable", "tunnel down");
    const [again] = seedHosts([cfg({ name: "renamed", portRangeEnd: 31099 })], hosts);
    expect(again).toMatchObject({ id: "local", name: "renamed", state: "unreachable", lastError: "tunnel down" });
    expect(again!.ports).toEqual({ rangeStart: 31000, rangeEnd: 31099 });
    expect(hosts.list().length).toBe(1);
  });

  test("GET /v1/hosts lists them and never leaks credentials in a connection string", async () => {
    const { hosts, get } = setup();
    seedHosts([cfg({ dockerHost: "ssh://root:hunter2hunter2@tower" })], hosts);
    const res = await get("/v1/hosts");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text).hosts[0]).toMatchObject({ id: "local", capabilities: ["preview"] });
  });

  const host = (id: string, state: Host["state"], caps: Host["capabilities"] = ["preview"]): Host => ({
    id, name: id, dockerHost: "x", expectName: null, capabilities: caps, publishBind: "127.0.0.1",
    upstream: { dial: "direct", address: "127.0.0.1", proxy: null }, ports: { rangeStart: 1, rangeEnd: 2 },
    state, lastError: null, lastSeenAt: null, createdAt: new Date(0),
  });

  test("placement", () => {
    expect(place({ capability: "preview" }, [host("local", "unknown")]).id).toBe("local");
    expect(place({ capability: "preview" }, [host("a", "unknown"), host("b", "ready")]).id).toBe("b");
    expect(place({ capability: "preview", hostId: "a" }, [host("a", "unknown"), host("b", "ready")]).id).toBe("a");
    expect(() => place({ capability: "preview" }, [host("a", "unreachable"), host("b", "error")])).toThrow(/no reachable host/);
    expect(() => place({ capability: "runner" }, [host("a", "ready")])).toThrow(/no reachable host/);
    expect(() => place({ capability: "preview", hostId: "r" }, [host("r", "ready", ["runner"])])).toThrow(/lacks/);
    expect(() => place({ capability: "preview", hostId: "zz" }, [host("a", "ready")])).toThrow(/does not exist/);
  });
});

describe("PreviewLogs", () => {
  const id = ulid();

  test("numbers lines, splits on CR (docker progress), drops blanks, survives a reopen", () => {
    const { dir } = setup();
    const logs = new PreviewLogs(dir, () => 42);
    logs.append(id, "build", "step 1\nstep 2\r\n\nprogress a\rprogress b\n");
    expect(logs.read(id).map((l) => [l.n, l.line])).toEqual([[1, "step 1"], [2, "step 2"], [3, "progress a"], [4, "progress b"]]);
    const reopened = new PreviewLogs(dir);
    reopened.append(id, "system", "after restart");
    expect(reopened.read(id, 4)).toMatchObject([{ n: 5, stream: "system", line: "after restart" }]);
  });

  test("redacts on the way in, clips absurd lines", () => {
    const { dir } = setup();
    const logs = new PreviewLogs(dir);
    logs.append(id, "stderr", "fatal: https://x-access-token:ghs_abcdefghijklmnopqrstuvwx@github.com/a/b.git");
    logs.append(id, "stdout", "x".repeat(20_000));
    const [a, b] = logs.read(id);
    expect(a!.line).not.toContain("ghs_");
    expect(b!.line.length).toBeLessThan(8300);
    expect(logs.tail(id, 1)[0]).toEndWith("[truncated]");
  });

  test("follow replays then streams, without duplicates; remove discards", () => {
    const { dir } = setup();
    const logs = new PreviewLogs(dir);
    logs.append(id, "build", "a\nb\nc");
    const got: number[] = [];
    const stop = logs.follow(id, 1, (l) => got.push(l.n));
    logs.append(id, "build", "d");
    stop();
    logs.append(id, "build", "e");
    expect(got).toEqual([2, 3, 4]);
    logs.remove(id);
    expect(logs.read(id)).toEqual([]);
  });

  test("an id that is not a ULID never becomes a path", () => {
    const { dir } = setup();
    const logs = new PreviewLogs(dir);
    expect(() => logs.read("../../etc/passwd")).toThrow(/not a preview id/);
    expect(() => logs.append("..", "system", "x")).toThrow();
  });
});
