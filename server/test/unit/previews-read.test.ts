/**
 * What the Previews and Preview-detail screens read, and the log stream for a long build.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { tokenActor, type Actor } from "../../src/auth/actor.ts";
import { type PreviewLogs } from "../../src/previews/logs.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { silentLogger } from "../helpers/logger.ts";

function make(actor: Actor = ACTOR, maxQueue?: number) {
  const s = setupPreviewContext();
  const api = new Hono<AppEnv>();
  api.onError(errorHandler(silentLogger()));
  api.use(async (c, next) => {
    c.set("requestId", "r");
    c.set("actor", actor);
    return next();
  });
  previewRoutes(api, s.ctx, null as never, {
    heartbeatMs: 10_000,
    ...(maxQueue === undefined ? {} : { maxQueue }),
  });
  return { ...s, get: (path: string, init?: RequestInit) => api.request(path, init) };
}

/** Reads `log` frames until `count` have arrived or the stream ends. */
async function frames(res: Response, count: number, timeoutMs = 3000) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: { id: number; stream: string; line: string }[] = [];
  let buf = "",
    ended = false;
  const deadline = Date.now() + timeoutMs;
  while (out.length < count && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null),
    ]);
    if (next === null) break;
    if (next.done) {
      ended = true;
      break;
    }
    buf += dec.decode(next.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const f = Object.fromEntries(
        buf
          .slice(0, i)
          .split("\n")
          .filter((l) => !l.startsWith(":"))
          .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]),
      );
      buf = buf.slice(i + 2);
      if (f["event"] === "log") {
        const d = JSON.parse(f["data"]!) as { stream: string; line: string };
        out.push({ id: Number(f["id"]), ...d });
      }
    }
  }
  await reader.cancel().catch(() => {});
  return { out, ended };
}

describe("GET /v1/previews", () => {
  test("carries the event cursor to follow from, read before the list", async () => {
    const t = make();
    const before = (await (await t.get("/previews")).json()) as {
      seq: number;
      previews: unknown[];
    };
    expect(before).toEqual({ seq: 0, previews: [] });
    const p = await t.deployed("one");
    const after = (await (await t.get("/previews")).json()) as {
      seq: number;
      previews: { id: string; urls: unknown[] }[];
    };
    expect(after.seq).toBe(t.ctx.bus.latestSeq());
    expect(after.seq).toBeGreaterThan(0);
    expect(after.previews.map((x) => x.id)).toEqual([p.id]);
    expect(after.previews[0]!.urls).toHaveLength(1);
  });

  test("state is repeatable or comma-joined; destroyed is left out unless asked for", async () => {
    const t = make();
    const live = await t.deployed("live");
    const gone = await t.deployed("gone");
    await destroy(t.ctx, gone.id, ACTOR);
    const ids = async (q: string) =>
      ((await (await t.get(`/previews${q}`)).json()) as { previews: { id: string }[] }).previews
        .map((p) => p.id)
        .sort();

    expect(await ids("")).toEqual([live.id]);
    expect(await ids("?includeDestroyed=true")).toEqual([live.id, gone.id].sort());
    expect(await ids("?state=destroyed")).toEqual([gone.id]);
    expect(await ids("?state=awake&state=destroyed")).toEqual([live.id, gone.id].sort());
    expect(await ids("?state=awake,destroyed")).toEqual([live.id, gone.id].sort());
    expect(await ids("?state=asleep,failed")).toEqual([]);
    expect((await t.get("/previews?state=banana")).status).toBe(422);
    expect((await t.get("/previews?state=awake,banana")).status).toBe(422);
  });
});

describe("GET /v1/previews/:id/events and /builds", () => {
  test("a preview's history, oldest first, with each event's payload flattened in", async () => {
    const t = make();
    const p = await t.deployed("storied");
    const { events } = (await (await t.get(`/previews/${p.id}/events`)).json()) as {
      events: { seq: number; type: string; state?: string; from?: string }[];
    };
    expect(events[0]).toMatchObject({ type: "preview.created", project: "gw-default-storied" });
    expect(events.filter((e) => e.type === "preview.state").map((e) => e.state)).toEqual([
      "starting",
      "awake",
    ]);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
  });

  test("builds: none for an image deploy; an unknown or malformed id is 404 before it names a file", async () => {
    const t = make();
    const p = await t.deployed("plain");
    expect(await (await t.get(`/previews/${p.id}/builds`)).json()).toEqual({ builds: [] });
    for (const path of [
      "/previews/nope/events",
      "/previews/..%2F..%2Fetc/builds",
      "/previews/01ARZ3NDEKTSV4RRFFQ69G5FAV/events",
    ]) {
      expect((await t.get(path)).status).toBe(404);
    }
  });

  test("a read-scoped token may read all of it; none of it without the permission", async () => {
    const reader = make(tokenActor("ro", ["read"]));
    const p = await reader.deployed("x");
    for (const path of [
      "/previews",
      `/previews/${p.id}`,
      `/previews/${p.id}/events`,
      `/previews/${p.id}/builds`,
    ])
      expect((await reader.get(path)).status).toBe(200);
    expect((await reader.get(`/previews/${p.id}`, { method: "DELETE" })).status).toBe(403);

    const nobody = make({
      kind: "user",
      userId: "u",
      roleId: "empty",
      permissions: new Set(),
      sessionId: "s",
    });
    for (const path of [
      "/previews",
      "/previews/x/events",
      "/previews/x/builds",
      "/previews/x/logs",
    ])
      expect((await nobody.get(path)).status).toBe(403);
  });
});

describe("GET /v1/previews/:id/logs", () => {
  const longLog = async (t: ReturnType<typeof make>, lines: number) => {
    const p = await t.deployed("chatty");
    const already = t.ctx.logs.read(p.id).length;
    t.ctx.logs.append(
      p.id,
      "build",
      Array.from({ length: lines - already }, (_, i) => `step ${already + i + 1}`).join("\n"),
    );
    expect(t.ctx.logs.read(p.id)).toHaveLength(lines);
    return p;
  };

  test("a log longer than the SSE queue still opens and streams", async () => {
    const t = make(ACTOR, 500);
    const p = await longLog(t, 1200);
    const { out, ended } = await frames(await t.get(`/previews/${p.id}/logs`), 499);
    expect(ended).toBe(false);
    expect(out).toHaveLength(499);
    // The cut is said out loud, once, first -- and numbered so a resume lands on the next line.
    expect(out[0]).toMatchObject({
      id: 1200 - 498,
      stream: "system",
      line: "... 702 earlier lines not shown",
    });
    expect(out[1]!.id).toBe(1200 - 497);
    expect(out.at(-1)).toMatchObject({ id: 1200, line: "step 1200" });
  });

  test("at the real default queue size too: 6,000 lines", async () => {
    const t = make();
    const p = await longLog(t, 6000);
    const { out, ended } = await frames(await t.get(`/previews/${p.id}/logs`), 4999, 10_000);
    expect(ended).toBe(false);
    expect(out[0]!.line).toBe("... 1002 earlier lines not shown");
    expect(out.at(-1)!.id).toBe(6000);
  }, 20_000);

  test("?tail=N starts from the last N and says what it skipped; a short log is not annotated", async () => {
    const t = make();
    const p = await longLog(t, 300);
    const tailed = await frames(await t.get(`/previews/${p.id}/logs?tail=10`), 11);
    expect(tailed.out.map((f) => f.id)).toEqual([
      290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300,
    ]);
    expect(tailed.out[0]).toMatchObject({
      stream: "system",
      line: "... 290 earlier lines not shown",
    });

    const whole = await frames(await t.get(`/previews/${p.id}/logs?tail=5000`), 300);
    expect(whole.out).toHaveLength(300);
    expect(whole.out.some((f) => f.line.includes("not shown"))).toBe(false);

    for (const bad of ["0", "-5", "many", "5001"])
      expect((await t.get(`/previews/${p.id}/logs?tail=${bad}`)).status).toBe(422);
  });

  test("resuming with Last-Event-ID ignores tail's cut: exactly the lines after the cursor, no notice", async () => {
    const t = make();
    const p = await longLog(t, 300);
    const resumed = await frames(
      await t.get(`/previews/${p.id}/logs?tail=2000`, { headers: { "last-event-id": "295" } }),
      5,
    );
    expect(resumed.out.map((f) => f.id)).toEqual([296, 297, 298, 299, 300]);
  });

  test("lines appended while the stream is open still arrive, after the replay, once", async () => {
    const t = make();
    const p = await longLog(t, 50);
    const res = await t.get(`/previews/${p.id}/logs?tail=3`);
    setTimeout(() => t.ctx.logs.append(p.id, "stdout", "live one\nlive two"), 50);
    const { out } = await frames(res, 6);
    expect(out.map((f) => f.line)).toEqual([
      "... 47 earlier lines not shown",
      "step 48",
      "step 49",
      "step 50",
      "live one",
      "live two",
    ]);
  });
});

describe("PreviewLogs.follow", () => {
  test("bounds apply to the REPLAY only; the follow that comes after is unbounded", () => {
    const t = make();
    const logs: PreviewLogs = t.ctx.logs;
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    logs.append(id, "build", Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n"));
    const got: string[] = [];
    const stop = logs.follow(id, 0, (l) => got.push(l.line), { maxReplay: 5 });
    expect(got).toEqual(["... 15 earlier lines not shown", "l16", "l17", "l18", "l19", "l20"]);
    logs.append(id, "build", Array.from({ length: 50 }, (_, i) => `live${i}`).join("\n"));
    expect(got).toHaveLength(56);
    stop();
  });

  test("with no bounds it behaves exactly as before", () => {
    const t = make();
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    t.ctx.logs.append(id, "build", "a\nb\nc");
    const got: number[] = [];
    t.ctx.logs.follow(id, 1, (l) => got.push(l.n))();
    expect(got).toEqual([2, 3]);
  });
});
