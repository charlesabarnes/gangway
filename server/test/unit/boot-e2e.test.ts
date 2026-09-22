/**
 * The Phase 1 milestone, end to end, with everything real except the Docker daemon:
 * real TLS listener, real Host-header dispatch, real Hono app, real SQLite, real proxy.
 * "compose up" is a fake that starts an HTTP fixture on the port gangway allocated --
 * which is exactly the contract a real container has to meet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type Running } from "../../src/boot.ts";
import { loadConfig } from "../../src/config.ts";
import type { ContainerSummary } from "../../src/docker/client.ts";
import type { ComposeEvent, ComposeResult } from "../../src/docker/compose.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { Logger } from "../../src/logger.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

async function start(stateDir: string, upstreamPort: number, seed?: ContainerSummary[], env: Record<string, string> = {}) {
  const fixtures = new Map<string, ReturnType<typeof Bun.serve>>();
  /** What the fake daemon would list: one "container" per `up`, labelled as the stack file said. */
  const containers = new Map<string, ContainerSummary>();
  const project = (argv: string[]) => argv[argv.indexOf("--project-name") + 1]!;
  // What `stop` and `start` need to remember: how to bring a project's stand-in back.
  const starters = new Map<string, () => void>();
  const stopped = new Set<string>();
  const compose: ComposeRunner = {
    async *stream(argv): AsyncGenerator<ComposeEvent> {
      const web = (await Bun.file(argv[argv.indexOf("--file") + 1]!).json()).services.web;
      const serve = () => fixtures.set(project(argv), Bun.serve({
        hostname: web.ports[0].host_ip, port: Number(web.ports[0].published),
        fetch: async (req) => {
          const slow = new URL(req.url).searchParams.get("slow");
          if (slow) await Bun.sleep(Number(slow));
          if (new URL(req.url).pathname === "/xff") return Response.json({ xff: req.headers.get("x-forwarded-for") });
          if (new URL(req.url).pathname === "/cookie") return Response.json({ cookie: req.headers.get("cookie"), path: new URL(req.url).pathname + new URL(req.url).search });
          return Response.json({ iAm: "the container", host: req.headers.get("host"), proto: req.headers.get("x-forwarded-proto"), publicUrl: web.environment.PUBLIC_URL });
        },
      }));
      serve();
      starters.set(project(argv), serve);
      containers.set(project(argv), {
        id: `c-${project(argv)}`, names: [`${project(argv)}-web-1`], image: web.image, state: "running", status: "Up", createdAt: new Date(),
        labels: web.labels, ports: [{ ip: web.ports[0].host_ip, containerPort: web.ports[0].target, hostPort: Number(web.ports[0].published), protocol: "tcp" }],
      });
      yield { type: "line", stream: "stderr", line: " Container web-1  Started" };
      yield { type: "exit", code: 0, signal: null };
    },
    async capture(argv): Promise<ComposeResult> {
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", signal: null });
      if (argv.includes("config")) {
        const file = argv[argv.indexOf("--file") + 1]!;
        return ok(JSON.stringify({ services: (await Bun.file(file).json()).services, networks: { default: { name: "gw-plan_default" } } }));
      }
      if (argv.includes("ps")) return ok(JSON.stringify({ Service: "web", State: stopped.has(project(argv)) ? "exited" : "running", ExitCode: 0 }));
      if (argv.includes("stop")) { fixtures.get(project(argv))?.stop(true); fixtures.delete(project(argv)); stopped.add(project(argv)); }
      if (argv.includes("start")) { starters.get(project(argv))?.(); stopped.delete(project(argv)); }
      if (argv.includes("down")) { fixtures.get(project(argv))?.stop(true); fixtures.delete(project(argv)); containers.delete(project(argv)); starters.delete(project(argv)); }
      return ok("");
    },
  };

  const config = loadConfig({
    GANGWAY_STATE_DIR: stateDir, GANGWAY_LISTEN_ADDRESS: "127.0.0.1", GANGWAY_LISTEN_PORT: String(await freePort()),
    GANGWAY_LISTEN_HTTP_PORT: "", GANGWAY_ADMIN_TOKEN: "gw_e2e_admin_token_0123456789abcdef", ...env,
  }, { hosts: [{ portRangeStart: upstreamPort, portRangeEnd: upstreamPort }] });
  config.publicPort = config.listenPort;

  // Injected, always: the default client would dial whatever Docker socket this machine has.
  const clients = { for: () => ({
    hostId: "local", info: async () => ({ Name: "test-daemon", OperatingSystem: "Linux" }),
    listContainers: async () => [...containers.values(), ...(seed ?? [])], stopContainer: async () => {},
  }) };
  const running = await boot(config, { compose, clients, announce: () => {}, logger: new Logger("error", {}, () => {}), timings: { pollIntervalMs: 10 } });
  cleanups.push(async () => { await running.stop(); for (const f of fixtures.values()) f.stop(true); });
  return Object.assign(running, { daemon: containers });
}

const client = (r: Running) => (host: string, path: string, init: RequestInit = {}) =>
  fetch(`https://127.0.0.1:${r.listener.port}${path}`, {
    ...init,
    headers: { host, authorization: `Bearer ${r.adminToken}`, ...(init.headers as Record<string, string> | undefined) },
    tls: { rejectUnauthorized: false }, redirect: "manual",
  } as RequestInit);

test("MILESTONE: deploy an image over REST, get a URL, open it, destroy it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const upstreamPort = await freePort();
  const running = await start(dir, upstreamPort);
  const call = client(running);
  const API = "api.preview.localhost";

  // The control plane is up, and guarded.
  expect(await (await call(API, "/healthz")).json()).toEqual({ ok: true, routes: 0 });
  expect((await call(API, "/v1/previews", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await (await call(API, "/v1/hosts")).json() as { hosts: unknown[] }).hosts.length).toBe(1);

  // Deploy.
  const res = await call(API, "/v1/previews?wait=true", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "hello", visibility: "public", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } }),
  });
  expect(res.status).toBe(201);
  const { preview } = await res.json() as { preview: { id: string; state: string; urls: { url: string }[] } };
  expect(preview.state).toBe("awake");
  expect(preview.urls[0]!.url).toBe(`https://hello.preview.localhost:${running.listener.port}/`);

  // Open it: through TLS, through dispatch, through the proxy, to "the container".
  const page = await call("hello.preview.localhost", "/some/path");
  expect(page.status).toBe(200);
  expect(await page.json()).toEqual({
    iAm: "the container", host: "hello.preview.localhost", proto: "https",
    publicUrl: `https://hello.preview.localhost:${running.listener.port}`,
  });

  // The API sees it; its log is streamable; a bad body is a 422, not a 500.
  const list = await (await call(API, "/v1/previews?state=awake")).json() as { previews: { id: string }[] };
  expect(list.previews.map((p) => p.id)).toEqual([preview.id]);
  const logs = await call(API, `/v1/previews/${preview.id}/logs`);
  const first = new TextDecoder().decode((await logs.body!.getReader().read()).value);
  expect(first).toContain("event: log");
  expect(first).toContain("deploying gw-default-hello");
  const bad = await call(API, "/v1/previews", { method: "POST", body: JSON.stringify({ source: { kind: "image", image: "--privileged", port: 80 } }) });
  expect(bad.status).toBe(422);
  expect((await call(API, "/v1/previews/not-an-id")).status).toBe(404);

  // Destroy: the URL stops existing.
  expect((await call(API, `/v1/previews/${preview.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await call("hello.preview.localhost", "/")).status).toBe(404);
  expect(await (await call(API, "/healthz")).json()).toEqual({ ok: true, routes: 0 });
});

test("§11 step 1: a restart serves existing routes immediately, and rescues interrupted pipelines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const upstreamPort = await freePort();

  const one = await start(dir, upstreamPort);
  const made = await client(one)("api.preview.localhost", "/v1/previews?wait=true", {
    method: "POST", body: JSON.stringify({ name: "survivor", visibility: "public", source: { kind: "image", image: "nginx", port: 80 } }),
  });
  const { preview } = await made.json() as { preview: { id: string } };
  // Simulate dying mid-pipeline on a second preview: a row stuck in `building`.
  one.ctx.previews.create({ id: "01J00000000000000000000000", project: "gw-stuck", hostId: "local", state: "building", source: { kind: "image", image: "x" }, visibility: "public" });
  one.listener.stop(true);

  // The containers outlive the process; the second boot's daemon still lists them.
  const two = await start(dir, upstreamPort, [...one.daemon.values()]);
  // §11 step 1: served from SQLite the moment boot returns, before any daemon has answered.
  expect(two.ctx.table.lookup("survivor.preview.localhost")).toMatchObject({ previewId: preview.id, state: "awake", upstreamPort });
  // Steps 2-3 happen behind the listener.
  const report = await two.reconciled;
  expect(report!.hosts[0]).toMatchObject({ reachable: true, containers: 1 });
  expect(two.ctx.previews.get(preview.id)!.state).toBe("awake");
  expect(two.ctx.previews.get("01J00000000000000000000000")).toMatchObject({ state: "failed", error: "interrupted by a server restart while building" });
});

test("T26: the scheduler owns the periodic work -- visits reach SQLite, an expired preview is swept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const running = await start(dir, await freePort());
  const call = client(running);
  expect(running.scheduler.status().map((j) => [j.name, j.enabled])).toEqual([["reconcile", true], ["ttl-sweep", true], ["lastseen-flush", true], ["idle-sleep", true], ["idempotency-purge", true], ["session-purge", true]]);

  const res = await call("api.preview.localhost", "/v1/previews?wait=true", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "brief", visibility: "public", ttl: "1s", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } }),
  });
  const { preview } = await res.json() as { preview: { id: string } };

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

describe("T29: graceful shutdown", () => {
  const deployHello = async (running: Running) => {
    const res = await client(running)("api.preview.localhost", "/v1/previews?wait=true", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "hello", visibility: "public", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } }),
    });
    expect(res.status).toBe(201);
  };

  test("a proxied request in flight completes; an open SSE stream is ended; stop() waits for both and no longer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const running = await start(dir, await freePort());
    const call = client(running);
    await deployHello(running);

    const events = await call("api.preview.localhost", "/v1/events");
    const reader = events.body!.getReader();
    const slow = call("hello.preview.localhost", "/?slow=400");
    await Bun.sleep(100);
    expect(running.listener.pending().requests).toBeGreaterThanOrEqual(2);

    const began = Date.now();
    await running.stop({ graceMs: 5_000 });
    const took = Date.now() - began;
    expect(took).toBeGreaterThanOrEqual(250); // it waited for the slow request...
    expect(took).toBeLessThan(3_000);         // ...and not for the grace period

    const page = await slow;
    expect(page.status).toBe(200);
    expect((await page.json() as { iAm: string }).iAm).toBe("the container");
    // The SSE stream was closed by the server, cleanly.
    for (;;) { if ((await reader.read()).done) break; }
    // stop() is idempotent, even after the database is closed.
    await running.stop();
  });

  test("a request that will not finish is cut at the deadline, not waited on forever", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const running = await start(dir, await freePort());
    await deployHello(running);
    const stuck = client(running)("hello.preview.localhost", "/?slow=30000").then((r) => r.status, () => "cut");
    await Bun.sleep(100);
    const began = Date.now();
    await running.stop({ graceMs: 300 });
    expect(Date.now() - began).toBeLessThan(2_500);
    expect(await stuck).not.toBe(200);
  });
});

test("T35: a retried POST with the same Idempotency-Key returns the same preview, marked as a replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const running = await start(dir, await freePort());
  const post = (name: string) => client(running)("api.preview.localhost", "/v1/previews?wait=true", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "agent-retry-1" },
    body: JSON.stringify({ name, visibility: "public", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } }),
  });
  const first = await post("once");
  const second = await post("once");
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(first.headers.get("idempotency-replayed")).toBeNull();
  expect(second.headers.get("idempotency-replayed")).toBe("true");
  const a = await first.json() as { preview: { id: string } };
  const b = await second.json() as { preview: { id: string; state: string } };
  expect(b.preview.id).toBe(a.preview.id);
  expect(b.preview.state).toBe("awake");
  expect((await post("other")).status).toBe(422);
  expect(running.daemon.size).toBe(1);
});

test("behind a reverse proxy: a preview sees the VISITOR in X-Forwarded-For only when the peer is a trusted proxy", async () => {
  const deployAndAsk = async (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const running = await start(dir, await freePort(), undefined, env);
    const call = client(running);
    await call("api.preview.localhost", "/v1/previews?wait=true", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "hello", visibility: "public", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } }),
    });
    // The test client is 127.0.0.1 -- standing in for the proxy -- and claims a visitor.
    return (await (await call("hello.preview.localhost", "/xff", { headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.7" } })).json() as { xff: string }).xff;
  };
  expect(await deployAndAsk({})).toBe("127.0.0.1");                                        // facing the internet: believe no one
  expect(await deployAndAsk({ GANGWAY_TRUSTED_PROXIES: "127.0.0.1" })).toBe("198.51.100.7"); // behind NPM: the hop NPM vouched for
});

test("T48: a PRIVATE preview -- login on app, a ticket, a cookie of its own, and a container that sees neither", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const running = await start(dir, await freePort());
  const port = running.listener.port;
  const raw = (host: string, path: string, init: RequestInit = {}) =>
    fetch(`https://127.0.0.1:${port}${path}`, { ...init, headers: { host: `${host}:${port}`, ...(init.headers as Record<string, string> | undefined) }, tls: { rejectUnauthorized: false }, redirect: "manual" } as RequestInit);
  const APP = "app.preview.localhost", SECRET = "secret.preview.localhost";

  // An admin, made the way production makes one; and a private preview.
  const setup = await raw(APP, "/v1/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(running.setupUrl!).searchParams.get("token"), email: "ada@example.com", password: "correct horse battery staple" }) });
  expect(setup.status).toBe(201);
  const session = setup.headers.get("set-cookie")!.split(";")[0]!;
  const deployed = await client(running)("api.preview.localhost", "/v1/previews?wait=true", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "secret", visibility: "private", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } }) });
  expect(deployed.status).toBe(201);

  // 1. A stranger gets a redirect to app, and the container hears nothing.
  const bounced = await raw(SECRET, "/cookie?x=1");
  expect(bounced.status).toBe(302);
  const toGate = new URL(bounced.headers.get("location")!);
  expect(`${toGate.host}${toGate.pathname}`).toBe(`${APP}:${port}/v1/auth/gate`);
  expect(toGate.searchParams.get("to")).toBe("/cookie?x=1");
  expect((await raw(SECRET, "/cookie", { headers: { "sec-fetch-mode": "cors" } })).status).toBe(401);

  // 2. app, not logged in: go and log in, and come back HERE.
  const anonymous = await raw(APP, `${toGate.pathname}${toGate.search}`);
  expect(anonymous.status).toBe(302);
  expect(anonymous.headers.get("location")).toStartWith("/login?returnUrl=%2Fv1%2Fauth%2Fgate");

  // ...the gate is not an open redirect: only a LIVE, PRIVATE preview will do.
  for (const host of ["evil.example", "api.preview.localhost", "nope.preview.localhost", ""]) {
    expect((await raw(APP, `/v1/auth/gate?host=${host}&to=/`, { headers: { cookie: session } })).status).toBe(404);
  }

  // 3. app, logged in: a ticket, in a URL on the preview's own host.
  const ticketed = await raw(APP, `${toGate.pathname}${toGate.search}`, { headers: { cookie: session } });
  expect(ticketed.status).toBe(302);
  const toPreview = new URL(ticketed.headers.get("location")!);
  expect(`${toPreview.host}${toPreview.pathname}`).toBe(`${SECRET}:${port}/__gangway/auth`);
  expect(ticketed.headers.get("referrer-policy")).toBe("no-referrer");

  // 4. The preview host trades the ticket for ITS OWN cookie, once.
  const redeemed = await raw(SECRET, `${toPreview.pathname}${toPreview.search}`);
  expect(redeemed.status).toBe(302);
  expect(redeemed.headers.get("location")).toBe("/cookie?x=1");
  const gateCookie = redeemed.headers.get("set-cookie")!.split(";")[0]!;
  expect(gateCookie).toStartWith("__Host-gw_pv=");
  expect((await raw(SECRET, `${toPreview.pathname}${toPreview.search}`)).status).toBe(403);

  // 5. In -- and the container sees the visitor's own cookies, and NOT gangway's.
  const inside = await raw(SECRET, "/cookie?x=1", { headers: { cookie: `theme=dark; ${gateCookie}` } });
  expect(inside.status).toBe(200);
  expect(await inside.json()).toEqual({ cookie: "theme=dark", path: "/cookie?x=1" });

  // The app SESSION cookie is not a key to the preview, and the preview's is not a session.
  expect((await raw(SECRET, "/cookie", { headers: { cookie: session } })).status).toBe(302);
  expect((await raw(APP, "/v1/previews", { headers: { cookie: gateCookie } })).status).toBe(401);

  // /__gangway/* never reaches a container, private or not.
  expect((await raw(SECRET, "/__gangway/whatever", { headers: { cookie: gateCookie } })).status).toBe(404);

  // A role WITHOUT previews.view_private is refused at the gate, by name.
  const roles = await raw(APP, "/v1/roles/viewer/permissions", { method: "PUT", headers: { cookie: session, origin: `https://${APP}:${port}`, "content-type": "application/json" }, body: JSON.stringify({ permissions: ["previews.read"] }) });
  expect(roles.status).toBe(200);
  await raw(APP, "/v1/users", { method: "POST", headers: { cookie: session, origin: `https://${APP}:${port}`, "content-type": "application/json" }, body: JSON.stringify({ email: "vic@example.com", password: "correct horse battery staple", roleId: "viewer" }) });
  const vic = (await raw(APP, "/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "vic@example.com", password: "correct horse battery staple" }) })).headers.get("set-cookie")!.split(";")[0]!;
  const refused = await raw(APP, `${toGate.pathname}${toGate.search}`, { headers: { cookie: vic } });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { detail: string }).detail).toContain("previews.view_private");
}, 30_000);

test("T53: the hooks surface is dispatched -- a signed delivery is 202'd on hooks.<base>, an unsigned one 401'd, and nothing else answers there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const running = await start(dir, await freePort(), undefined, { GANGWAY_GITHUB_WEBHOOK_SECRET: "hook-s3cret" });
  const call = client(running);
  const HOOKS = "hooks.preview.localhost";

  const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const headers = (secret: string) => ({ "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": "e2e-1", "x-hub-signature-256": sign(secret), authorization: "" });

  const ok = await call(HOOKS, "/github", { method: "POST", body, headers: headers("hook-s3cret") });
  expect(ok.status).toBe(202);
  expect(await ok.json()).toEqual({ accepted: false, deliveryId: "e2e-1", reason: "ping" });
  expect((await call(HOOKS, "/github", { method: "POST", body, headers: headers("wrong") })).status).toBe(401);
  // The API does not answer on the hooks host, and hooks do not answer on the API host.
  expect((await call(HOOKS, "/v1/previews")).status).toBe(404);
  expect((await call("api.preview.localhost", "/github", { method: "POST", body, headers: headers("hook-s3cret") })).status).toBe(404);
});

test("T57/T58: idle-sleep stops the stack; the next request wakes it and is answered by the container", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gangway-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const upstreamPort = await freePort();
  // Swept every 100 ms, flushed every 50 ms; a wake gets 2 s before the 202 page.
  const running = await start(dir, upstreamPort, undefined, {
    GANGWAY_IDLE_SWEEP_INTERVAL_MS: "100", GANGWAY_LAST_SEEN_FLUSH_INTERVAL_MS: "50", GANGWAY_WAKE_WAIT_MS: "2000",
  });
  const call = client(running);
  const API = "api.preview.localhost";
  // A one-second idle window comes from the template (ADR-0013), edited through the API.
  const edited = await call(API, "/v1/templates/default", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ idleAfter: "1s" }) });
  expect(edited.status).toBe(200);

  const res = await call(API, "/v1/previews?wait=true", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "sleepy", visibility: "public", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } }),
  });
  const { preview } = await res.json() as { preview: { id: string; state: string } };
  expect(preview.state).toBe("awake");
  const HOST = "sleepy.preview.localhost";
  expect((await call(HOST, "/")).status).toBe(200);

  // Idle for over a second: the sweep puts it to sleep, and the stand-in container is gone.
  const asleep = async () => ((await (await call(API, `/v1/previews/${preview.id}`)).json()) as { preview: { state: string } }).preview.state === "asleep";
  const deadline = Date.now() + 5_000;
  while (!(await asleep()) && Date.now() < deadline) await Bun.sleep(50);
  expect(await asleep()).toBe(true);
  expect(await fetch(`http://127.0.0.1:${upstreamPort}/`).then(() => true, () => false)).toBe(false);

  // The next request wakes it -- and is answered by the container, not by a waking page.
  const woke = await call(HOST, "/");
  expect(woke.status).toBe(200);
  expect(await woke.json()).toMatchObject({ iAm: "the container" });
  expect(((await (await call(API, `/v1/previews/${preview.id}`)).json()) as { preview: { state: string } }).preview.state).toBe("awake");
  const { events } = await (await call(API, `/v1/previews/${preview.id}/events`)).json() as { events: { type: string; state?: string }[] };
  const states = events.filter((e) => e.type === "preview.state").map((e) => e.state);
  expect(states.slice(-3)).toEqual(["asleep", "starting", "awake"]);
}, 15_000);
