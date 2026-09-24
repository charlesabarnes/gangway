/** Everything real except the Docker daemon, whose stand-in serves HTTP on the allocated port. */
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { tempDir } from "../helpers/db.ts";
import { bootWithFakeDaemon, client } from "../helpers/fake-daemon.ts";
import { freePort } from "../helpers/free-port.ts";
import { API, bootE2e, deployPreview, WHOAMI } from "../helpers/boot-e2e.ts";

test("deploys an image over REST, serves its URL, and destroys it", async () => {
  const { running, call } = await bootE2e();

  expect(await (await call(API, "/healthz")).json()).toEqual({ ok: true, routes: 0 });
  expect(
    (await call(API, "/v1/previews", { headers: { authorization: "Bearer nope" } })).status,
  ).toBe(401);
  expect(
    ((await (await call(API, "/v1/hosts")).json()) as { hosts: unknown[] }).hosts,
  ).toHaveLength(1);

  const res = await deployPreview(running, { name: "hello" });
  expect(res.status).toBe(201);
  const { preview } = (await res.json()) as {
    preview: { id: string; state: string; urls: { url: string }[] };
  };
  expect(preview.state).toBe("awake");
  expect(preview.urls[0]!.url).toBe(`https://hello.preview.localhost:${running.listener.port}/`);

  const page = await call("hello.preview.localhost", "/some/path");
  expect(page.status).toBe(200);
  expect(await page.json()).toEqual({
    iAm: "the container",
    host: "hello.preview.localhost",
    proto: "https",
    publicUrl: `https://hello.preview.localhost:${running.listener.port}`,
  });

  const list = (await (await call(API, "/v1/previews?state=awake")).json()) as {
    previews: { id: string }[];
  };
  expect(list.previews.map((p) => p.id)).toEqual([preview.id]);
  const logs = await call(API, `/v1/previews/${preview.id}/logs`);
  const first = new TextDecoder().decode((await logs.body!.getReader().read()).value);
  expect(first).toContain("event: log");
  expect(first).toContain("deploying gw-default-hello");
  const bad = await call(API, "/v1/previews", {
    method: "POST",
    body: JSON.stringify({ source: { kind: "image", image: "--privileged", port: 80 } }),
  });
  expect(bad.status).toBe(422);
  expect((await call(API, "/v1/previews/not-an-id")).status).toBe(404);

  expect((await call(API, `/v1/previews/${preview.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await call("hello.preview.localhost", "/")).status).toBe(404);
  expect(await (await call(API, "/healthz")).json()).toEqual({ ok: true, routes: 0 });
});

test("a restart serves existing routes at once and fails interrupted pipelines", async () => {
  const dir = tempDir();
  const upstreamPort = await freePort();

  const one = await bootWithFakeDaemon(dir, upstreamPort);
  const made = await deployPreview(one, {
    name: "survivor",
    source: { kind: "image", image: "nginx", port: 80 },
  });
  const { preview } = (await made.json()) as { preview: { id: string } };
  // A row stuck in `building` stands in for dying mid-pipeline.
  one.ctx.previews.create({
    id: "01J00000000000000000000000",
    project: "gw-stuck",
    hostId: "local",
    state: "building",
    source: { kind: "image", image: "x" },
    visibility: "public",
  });
  one.listener.stop(true);

  // The containers outlive the process, so the second boot's daemon still lists them.
  const two = await bootWithFakeDaemon(dir, upstreamPort, [...one.daemon.values()]);
  // Served from SQLite the moment boot returns, before any daemon has answered.
  expect(two.ctx.table.lookup("survivor.preview.localhost")).toMatchObject({
    previewId: preview.id,
    state: "awake",
    upstreamPort,
  });
  const report = await two.reconciled;
  expect(report!.hosts[0]).toMatchObject({ reachable: true, containers: 1 });
  expect(two.ctx.previews.get(preview.id)!.state).toBe("awake");
  expect(two.ctx.previews.get("01J00000000000000000000000")).toMatchObject({
    state: "failed",
    error: "interrupted by a server restart while building",
  });
});

test("the scheduler flushes visits to SQLite and sweeps an expired preview", async () => {
  const { running, call } = await bootE2e();
  expect(running.scheduler.status().map((j) => [j.name, j.enabled])).toEqual([
    ["reconcile", true],
    ["ttl-sweep", true],
    ["lastseen-flush", true],
    ["idle-sleep", true],
    ["idempotency-purge", true],
    ["session-purge", true],
    ["oauth-purge", true],
    ["update-check", true],
  ]);

  const res = await deployPreview(running, { name: "brief", ttl: "1s" });
  const { preview } = (await res.json()) as { preview: { id: string } };

  expect(running.ctx.previews.get(preview.id)!.lastSeenAt).toBeNull();
  expect((await call("brief.preview.localhost", "/")).status).toBe(200);
  await running.scheduler.trigger("lastseen-flush");
  expect(running.ctx.previews.get(preview.id)!.lastSeenAt).not.toBeNull();

  await Bun.sleep(1_050);
  await running.scheduler.trigger("ttl-sweep");
  expect(running.ctx.previews.get(preview.id)!.state).toBe("destroyed");
  expect((await call("brief.preview.localhost", "/")).status).toBe(404);
  expect(running.daemon.size).toBe(0);
});

test("a retried POST with the same Idempotency-Key replays the same preview", async () => {
  const { running } = await bootE2e();
  const post = (name: string) =>
    client(running)(API, "/v1/previews?wait=true", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "agent-retry-1" },
      body: JSON.stringify({ name, visibility: "public", source: WHOAMI }),
    });
  const first = await post("once");
  const second = await post("once");
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(first.headers.get("idempotency-replayed")).toBeNull();
  expect(second.headers.get("idempotency-replayed")).toBe("true");
  const a = (await first.json()) as { preview: { id: string } };
  const b = (await second.json()) as { preview: { id: string; state: string } };
  expect(b.preview.id).toBe(a.preview.id);
  expect(b.preview.state).toBe("awake");
  expect((await post("other")).status).toBe(422);
  expect(running.daemon.size).toBe(1);
});

test.each([
  ["facing the internet, believes no one", {}, "127.0.0.1"],
  [
    "behind a trusted proxy, passes the hop it vouched for",
    { GANGWAY_TRUSTED_PROXIES: "127.0.0.1" },
    "198.51.100.7",
  ],
])("X-Forwarded-For %s", async (_where, env, want) => {
  const { running, call } = await bootE2e(env);
  await deployPreview(running, { name: "hello" });
  // The test client is 127.0.0.1, standing in for the proxy, and claims a visitor.
  const res = await call("hello.preview.localhost", "/xff", {
    headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.7" },
  });
  expect(((await res.json()) as { xff: string }).xff).toBe(want);
});

test("the hooks host accepts signed deliveries only and serves nothing else", async () => {
  const { call } = await bootE2e({ GANGWAY_GITHUB_WEBHOOK_SECRET: "hook-s3cret" });
  const HOOKS = "hooks.preview.localhost";
  const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const headers = (secret: string) => ({
    "content-type": "application/json",
    "x-github-event": "ping",
    "x-github-delivery": "e2e-1",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    authorization: "",
  });

  const ok = await call(HOOKS, "/github", {
    method: "POST",
    body,
    headers: headers("hook-s3cret"),
  });
  expect(ok.status).toBe(202);
  expect(await ok.json()).toEqual({ accepted: false, deliveryId: "e2e-1", reason: "ping" });
  expect(
    (await call(HOOKS, "/github", { method: "POST", body, headers: headers("wrong") })).status,
  ).toBe(401);
  expect((await call(HOOKS, "/v1/previews")).status).toBe(404);
  expect(
    (await call(API, "/github", { method: "POST", body, headers: headers("hook-s3cret") })).status,
  ).toBe(404);
});

test("idle-sleep stops the stack and the next request wakes it", async () => {
  const upstreamPort = await freePort();
  // Swept every 100 ms, flushed every 50 ms; a wake gets 2 s before the 202 page.
  const { running, call } = await bootE2e(
    {
      GANGWAY_IDLE_SWEEP_INTERVAL_MS: "100",
      GANGWAY_LAST_SEEN_FLUSH_INTERVAL_MS: "50",
      GANGWAY_WAKE_WAIT_MS: "2000",
    },
    upstreamPort,
  );
  const edited = await call(API, "/v1/templates/default", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idleAfter: "1s" }),
  });
  expect(edited.status).toBe(200);

  const res = await deployPreview(running, { name: "sleepy" });
  const { preview } = (await res.json()) as { preview: { id: string; state: string } };
  expect(preview.state).toBe("awake");
  const HOST = "sleepy.preview.localhost";
  expect((await call(HOST, "/")).status).toBe(200);

  const state = async () =>
    (
      (await (await call(API, `/v1/previews/${preview.id}`)).json()) as {
        preview: { state: string };
      }
    ).preview.state;
  const deadline = Date.now() + 5_000;
  while ((await state()) !== "asleep" && Date.now() < deadline) await Bun.sleep(50);
  expect(await state()).toBe("asleep");
  expect(
    await fetch(`http://127.0.0.1:${upstreamPort}/`).then(
      () => true,
      () => false,
    ),
  ).toBe(false);

  const woke = await call(HOST, "/");
  expect(woke.status).toBe(200);
  expect(await woke.json()).toMatchObject({ iAm: "the container" });
  expect(await state()).toBe("awake");
  const { events } = (await (await call(API, `/v1/previews/${preview.id}/events`)).json()) as {
    events: { type: string; state?: string }[];
  };
  const states = events.filter((e) => e.type === "preview.state").map((e) => e.state);
  expect(states.slice(-3)).toEqual(["asleep", "starting", "awake"]);
}, 15_000);
