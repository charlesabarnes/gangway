/**
 * The Phase 1 milestone, end to end, with everything real except the Docker daemon:
 * real TLS listener, real Host-header dispatch, real Hono app, real SQLite, real proxy.
 * "compose up" is a fake that starts an HTTP fixture on the port gangway allocated --
 * which is exactly the contract a real container has to meet.
 */
import { afterEach, expect, test } from "bun:test";
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

async function start(stateDir: string, upstreamPort: number, seed?: ContainerSummary[]) {
  const fixtures = new Map<string, ReturnType<typeof Bun.serve>>();
  /** What the fake daemon would list: one "container" per `up`, labelled as the stack file said. */
  const containers = new Map<string, ContainerSummary>();
  const project = (argv: string[]) => argv[argv.indexOf("--project-name") + 1]!;
  const compose: ComposeRunner = {
    async *stream(argv): AsyncGenerator<ComposeEvent> {
      const web = (await Bun.file(argv[argv.indexOf("--file") + 1]!).json()).services.web;
      fixtures.set(project(argv), Bun.serve({
        hostname: web.ports[0].host_ip, port: Number(web.ports[0].published),
        fetch: (req) => Response.json({ iAm: "the container", host: req.headers.get("host"), proto: req.headers.get("x-forwarded-proto"), publicUrl: web.environment.PUBLIC_URL }),
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
    GANGWAY_LISTEN_HTTP_PORT: "", GANGWAY_ADMIN_TOKEN: "gw_e2e_admin_token_0123456789abcdef",
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
