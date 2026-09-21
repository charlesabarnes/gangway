/**
 * The Phase 1 milestone, end to end, with everything real except the Docker daemon:
 * real TLS listener, real Host-header dispatch, real Hono app, real SQLite, real proxy.
 * "compose up" is a fake that starts an HTTP fixture on the port gangway allocated --
 * which is exactly the contract a real container has to meet.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
  const compose: ComposeRunner = {
    async *stream(argv): AsyncGenerator<ComposeEvent> {
      const web = (await Bun.file(argv[argv.indexOf("--file") + 1]!).json()).services.web;
      fixtures.set(project(argv), Bun.serve({
        hostname: web.ports[0].host_ip, port: Number(web.ports[0].published),
        fetch: async (req) => {
          const slow = new URL(req.url).searchParams.get("slow");
          if (slow) await Bun.sleep(Number(slow));
          if (new URL(req.url).pathname === "/xff") return Response.json({ xff: req.headers.get("x-forwarded-for") });
          return Response.json({ iAm: "the container", host: req.headers.get("host"), proto: req.headers.get("x-forwarded-proto"), publicUrl: web.environment.PUBLIC_URL });
        },
      }));
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
      if (argv.includes("ps")) return ok(JSON.stringify({ Service: "web", State: "running" }));
      if (argv.includes("down")) { fixtures.get(project(argv))?.stop(true); fixtures.delete(project(argv)); containers.delete(project(argv)); }
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
  const running = await boot(config, { compose, clients, logger: new Logger("error", {}, () => {}), timings: { pollIntervalMs: 10 } });
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
  expect(first).toContain("deploying gw-hello");
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
  expect(running.scheduler.status().map((j) => [j.name, j.enabled])).toEqual([["reconcile", true], ["ttl-sweep", true], ["lastseen-flush", true], ["idempotency-purge", true]]);

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
