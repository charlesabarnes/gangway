import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { staticTokenVerifier, type Actor } from "../../src/auth/actor.ts";
import { Audit } from "../../src/audit/audit.ts";
import {
  AuditRepo,
  BuildsRepo,
  EventsRepo,
  PreviewsRepo,
  RoutesRepo,
} from "../../src/db/repos/index.ts";
import type { ComposeEvent, ComposeResult } from "../../src/docker/compose.ts";
import { parseLabels } from "../../src/docker/labels.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { EventBus } from "../../src/events/bus.ts";
import type { PreviewContext } from "../../src/previews/context.ts";
import { deploy, type DeployInput } from "../../src/previews/deploy.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { PreviewLogs } from "../../src/previews/logs.ts";
import { Workdirs } from "../../src/previews/source/workdir.ts";
import { canTransition, PreviewStates } from "../../src/previews/state.ts";
import { RouteTable } from "../../src/routing/table.ts";
import { silentLogger } from "../helpers/logger.ts";
import { tempDb } from "../helpers/db.ts";
import { seededHosts } from "../helpers/hosts.ts";

const ACTOR = staticTokenVerifier("x")("x") as Actor;
const cmdOf = (argv: string[]) =>
  argv.find((a) => ["config", "build", "up", "ps", "down", "logs"].includes(a))!;

type Script = {
  /** What the compose file resolves to. Defaults to reading the generated image stack. */
  config?: (file: string) => unknown;
  up?: { code: number; lines?: string[]; hang?: boolean };
  ps?: Array<Record<string, unknown>[]>;
  down?: { code: number; stderr?: string } | "throw";
  probe?: boolean[];
};

function setup(script: Script = {}) {
  const { db, dir } = tempDb();
  const hosts = seededHosts(db, { portRangeStart: 31000, portRangeEnd: 31002 });
  const previews = new PreviewsRepo(db);
  const table = new RouteTable(new RoutesRepo(db));
  const bus = new EventBus(new EventsRepo(db));
  const logs = new PreviewLogs(dir);

  const calls: {
    cmd: string;
    argv: string[];
    cwd: string;
    routesAtCall: number;
    stack: string | null;
  }[] = [];
  const record = (argv: string[], cwd: string) => {
    const f = argv[argv.indexOf("--file") + 1];
    calls.push({
      cmd: cmdOf(argv),
      argv,
      cwd,
      routesAtCall: table.size,
      stack: f && existsSync(f) ? readFileSync(f, "utf8") : null,
    });
  };
  const psQueue = [...(script.ps ?? [[{ Service: "web", State: "running", Health: "" }]])];
  const probeQueue = [...(script.probe ?? [true])];

  const compose: ComposeRunner = {
    async *stream(argv, _host, o): AsyncGenerator<ComposeEvent> {
      record(argv, o.cwd);
      const up = script.up ?? { code: 0, lines: ["Container gw-web-1  Started"] };
      for (const line of up.lines ?? []) yield { type: "line", stream: "stderr", line };
      if (up.hang)
        await new Promise<void>((resolve) => o.signal?.addEventListener("abort", () => resolve()));
      o.signal?.throwIfAborted();
      yield { type: "exit", code: up.code, signal: null };
    },
    async capture(argv, _host, o): Promise<ComposeResult> {
      record(argv, o.cwd);
      const ok = (stdout: string): ComposeResult => ({ code: 0, stdout, stderr: "", signal: null });
      switch (cmdOf(argv)) {
        case "config": {
          const file = argv[argv.indexOf("--file") + 1]!;
          const doc = script.config?.(file) ?? {
            services: JSON.parse(readFileSync(file, "utf8")).services,
            networks: { default: { name: "gw-plan_default" } },
          };
          if (doc === "invalid")
            return {
              code: 15,
              stdout: "",
              stderr: "yaml: line 3: did not find expected key",
              signal: null,
            };
          return ok(JSON.stringify(doc));
        }
        case "ps":
          return ok(
            (psQueue.length > 1 ? psQueue.shift()! : psQueue[0]!)
              .map((r) => JSON.stringify(r))
              .join("\n"),
          );
        case "logs":
          return ok("web-1  | Error: listen EADDRINUSE");
        case "down":
          if (script.down === "throw") throw new Error("connect ECONNREFUSED");
          return {
            code: script.down?.code ?? 0,
            stdout: "",
            stderr: script.down?.stderr ?? "",
            signal: null,
          };
      }
      return ok("");
    },
  };

  const ctx: PreviewContext = {
    instance: "default",
    env: "test",
    origin: { scheme: "https", port: 8443 },
    baseDomain: () => "preview.localhost",
    policy: fixedPolicy(),
    hosts,
    previews,
    table,
    bus,
    logs,
    compose,
    states: new PreviewStates(previews, table, bus),
    workdirs: new Workdirs(dir),
    probe: async () => (probeQueue.length > 1 ? probeQueue.shift()! : probeQueue[0]!),
    logger: silentLogger(),
    timings: { startTimeoutMs: 150, probeTimeoutMs: 150, pollIntervalMs: 5 },
    now: Date.now,
    inflight: new Map(),
    teardowns: new Set(),
    builds: new BuildsRepo(db),
    audit: new Audit(new AuditRepo(db), silentLogger()),
  };
  const input = (o: Partial<DeployInput> = {}): DeployInput => ({
    actor: ACTOR,
    source: { kind: "image", image: "ghcr.io/acme/web-app:1.2", port: 3000 },
    visibility: "public",
    ...o,
  });
  const events = () =>
    bus &&
    new EventsRepo(db)
      .since(0)
      .map((e) => `${e.type}${e.payload["state"] ? `:${String(e.payload["state"])}` : ""}`);
  return { ctx, calls, input, events, dir, table, previews, logs };
}

describe("deploy: the happy path", () => {
  test("image -> awake, with a URL known before a single container exists", async () => {
    const { ctx, input, calls, events, dir, logs } = setup();
    const res = await deploy(ctx, input());

    expect(res.preview).toMatchObject({
      state: "building",
      project: "gw-default-web-app",
      hostId: "local",
      source: { kind: "image", image: "ghcr.io/acme/web-app:1.2" },
    });
    expect(res.urls).toEqual([
      { service: "web", url: "https://web-app.preview.localhost:8443/", primary: true },
    ]);
    expect(ctx.table.lookup("web-app.preview.localhost")).toMatchObject({
      state: "building",
      upstreamPort: 31000,
    });

    const final = await res.done;
    expect(final.state).toBe("awake");
    expect(ctx.table.lookup("web-app.preview.localhost")!.state).toBe("awake");
    expect(events()).toEqual(["preview.created", "preview.state:starting", "preview.state:awake"]);
    expect(calls.map((c) => c.cmd)).toEqual(["config", "up", "ps"]);
    // YAML output: `--format json` silently drops service-level x-gangway.
    expect(calls[0]!.argv).not.toContain("--format");
    expect(logs.tail(res.preview.id).join("\n")).toContain("Started");
    expect(ctx.inflight.size).toBe(0);
    expect(existsSync(join(dir, "work", res.preview.id))).toBe(false);
  });

  test("the route row exists BEFORE `compose up` runs -- never after", async () => {
    const { ctx, input, calls } = setup();
    await (
      await deploy(ctx, input())
    ).done;
    expect(calls.find((c) => c.cmd === "config")!.routesAtCall).toBe(0);
    expect(calls.find((c) => c.cmd === "up")!.routesAtCall).toBe(1);
  });

  test("`up` runs ONE file -- the generated stack -- under the real project name", async () => {
    const { ctx, input, calls } = setup();
    const res = await deploy(ctx, input());
    await res.done;
    const up = calls.find((c) => c.cmd === "up")!;
    expect(up.argv.slice(0, 4)).toEqual([
      "docker",
      "compose",
      "--project-name",
      "gw-default-web-app",
    ]);
    expect(
      up.argv.filter((_, i) => up.argv[i - 1] === "--file").map((f) => f.split("/").pop()),
    ).toEqual(["gangway.stack.yaml"]);
    expect(up.argv.slice(-4)).toEqual(["up", "-d", "--no-build", "--remove-orphans"]);
    const stack = JSON.parse(up.stack!);
    expect(stack.name).toBe("gw-default-web-app");
    expect(stack.services.web.ports).toEqual([
      { mode: "ingress", host_ip: "127.0.0.1", target: 3000, published: "31000", protocol: "tcp" },
    ]);
    expect("name" in stack.networks.default).toBe(false);
    expect(parseLabels(stack.services.web.labels)).toMatchObject({
      ok: true,
      labels: {
        previewId: res.preview.id,
        hostname: "web-app.preview.localhost",
        port: 31000,
        env: "test",
      },
    });
  });

  test("unlisted (the default) gets an unguessable hostname; ttl defaults apply; null disables", async () => {
    const { ctx, input } = setup();
    const a = await deploy(ctx, input({ visibility: undefined, name: "Demo App" }));
    expect(a.urls[0]!.url).toMatch(/^https:\/\/demo-app-[a-z0-9]{10}\.preview\.localhost:8443\/$/);
    expect(a.preview.visibility).toBe("unlisted");
    expect(a.preview.ttlExpiresAt!.getTime() - a.preview.createdAt.getTime()).toBe(7 * 86_400_000);
    const b = await deploy(ctx, input({ name: "forever", ttl: null }));
    expect(b.preview.ttlExpiresAt).toBeNull();
    await Promise.all([a.done, b.done]);
  });

  test("waits out `starting` health and a port that is not answering yet", async () => {
    const { ctx, input, logs } = setup({
      ps: [
        [{ Service: "web", State: "running", Health: "starting" }],
        [{ Service: "web", State: "running", Health: "healthy" }],
      ],
      probe: [false, false, true],
    });
    const res = await deploy(ctx, input());
    expect((await res.done).state).toBe("awake");
    expect(logs.tail(res.preview.id).join("\n")).toContain("waiting for web: starting");
  });

  test("a one-shot sidecar that exited 0 does not hold the stack back", async () => {
    const { ctx, input } = setup({
      ps: [
        [
          { Service: "web", State: "running" },
          { Service: "migrate", State: "exited", ExitCode: 0 },
        ],
      ],
    });
    expect((await (await deploy(ctx, input())).done).state).toBe("awake");
  });
});

describe("deploy: planning failures leave nothing behind and are the caller's 4xx", () => {
  const nothingLeft = (s: ReturnType<typeof setup>) => {
    expect(s.previews.list({ includeDestroyed: true })).toEqual([]);
    expect(s.table.size).toBe(0);
    expect(s.calls.some((c) => c.cmd === "up")).toBe(false);
    expect(
      existsSync(join(s.dir, "work"))
        ? Bun.spawnSync(["ls", join(s.dir, "work")]).stdout.toString()
        : "",
    ).toBe("");
  };

  test("an invalid compose file", async () => {
    const s = setup({ config: () => "invalid" });
    await expect(deploy(s.ctx, s.input())).rejects.toMatchObject({
      status: 422,
      detail: { compose: expect.stringContaining("did not find expected key") },
    });
    nothingLeft(s);
  });

  test("a policy violation", async () => {
    const s = setup({
      config: () => ({
        services: {
          web: { image: "x", privileged: true, ports: [{ target: 80, protocol: "tcp" }] },
        },
      }),
    });
    await expect(deploy(s.ctx, s.input())).rejects.toMatchObject({
      status: 422,
      detail: { violations: ['service "web": privileged is not allowed'] },
    });
    nothingLeft(s);
  });

  test("reserved names, bad ttl, private visibility, unknown host", async () => {
    const s = setup();
    await expect(deploy(s.ctx, s.input({ name: "api" }))).rejects.toMatchObject({ status: 422 });
    await expect(deploy(s.ctx, s.input({ ttl: "soon" }))).rejects.toMatchObject({ status: 422 });
    // Private is opened by logging in to the UI; with the UI off, say so now rather than hand out a dead link.
    s.ctx.privateAvailable = () => false;
    await expect(deploy(s.ctx, s.input({ visibility: "private" }))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("switched off"),
    });
    s.ctx.privateAvailable = () => true;
    await expect(deploy(s.ctx, s.input({ hostId: "elsewhere" }))).rejects.toMatchObject({
      status: 422,
    });
    nothingLeft(s);
  });

  test("a private preview deploys like any other, and its route carries the visibility the gate reads", async () => {
    const s = setup();
    const res = await deploy(s.ctx, s.input({ name: "secret", visibility: "private" }));
    expect((await res.done).visibility).toBe("private");
    expect(s.ctx.table.lookup("secret.preview.localhost")).toMatchObject({
      visibility: "private",
      previewId: res.preview.id,
    });
  });

  test("a live name is a 409; a destroyed one is reusable", async () => {
    const s = setup();
    const first = await deploy(s.ctx, s.input());
    await first.done;
    await expect(deploy(s.ctx, s.input())).rejects.toMatchObject({
      status: 409,
      detail: { previewId: first.preview.id },
    });
    await destroy(s.ctx, first.preview.id, ACTOR);
    const second = await deploy(s.ctx, s.input());
    expect(second.urls).toEqual(first.urls);
    expect((await second.done).state).toBe("awake");
    expect(s.previews.list({ includeDestroyed: true }).map((p) => p.id)).toEqual([
      second.preview.id,
    ]);
  });

  test("the port pool is finite, and says so", async () => {
    const s = setup();
    for (const name of ["a1", "a2", "a3"]) await (await deploy(s.ctx, s.input({ name }))).done;
    expect(s.table.usedPorts("127.0.0.1")).toEqual(new Set([31000, 31001, 31002]));
    await expect(deploy(s.ctx, s.input({ name: "a4" }))).rejects.toMatchObject({ status: 503 });
  });

  test("concurrent deploys never share a port", async () => {
    const s = setup();
    const all = await Promise.all(
      ["c1", "c2", "c3"].map((name) => deploy(s.ctx, s.input({ name }))),
    );
    await Promise.all(all.map((r) => r.done));
    expect(s.table.usedPorts("127.0.0.1").size).toBe(3);
  });
});

describe("deploy: run failures leave a `failed` preview that explains itself", () => {
  test("`up` exits non-zero: container logs are salvaged, the stack is torn down, the route stays", async () => {
    const s = setup({
      up: { code: 1, lines: ["Error response from daemon: port is already allocated"] },
    });
    const res = await deploy(s.ctx, s.input());
    const final = await res.done;
    expect(final).toMatchObject({ state: "failed", error: "compose up exited 1" });
    expect(s.calls.map((c) => c.cmd)).toEqual(["config", "up", "logs", "down"]);
    const down = s.calls.at(-1)!;
    expect(down.argv).not.toContain("--file");
    // A failed stack's containers go; its volumes (an add-on's data) stay until destroy.
    expect(down.argv.slice(-4)).toEqual(["down", "--remove-orphans", "--rmi", "local"]);
    const tail = s.logs.tail(res.preview.id).join("\n");
    expect(tail).toContain("port is already allocated");
    expect(tail).toContain("EADDRINUSE");
    expect(s.table.lookup("web-app.preview.localhost")!.state).toBe("failed");
  });

  test("a crashed service, an unhealthy one, and a start timeout", async () => {
    const crashed = setup({ ps: [[{ Service: "web", State: "exited", ExitCode: 137 }]] });
    expect((await (await deploy(crashed.ctx, crashed.input())).done).error).toBe(
      'service "web" exited with code 137',
    );
    const sick = setup({ ps: [[{ Service: "web", State: "running", Health: "unhealthy" }]] });
    expect((await (await deploy(sick.ctx, sick.input())).done).error).toBe(
      'service "web" is unhealthy',
    );
    const slow = setup({ ps: [[{ Service: "web", State: "running", Health: "starting" }]] });
    expect((await (await deploy(slow.ctx, slow.input())).done).error).toMatch(
      /timed out after .* waiting for web: starting/,
    );
  });

  test("healthy but never answering HTTP names the likely causes", async () => {
    const s = setup({ probe: [false] });
    expect((await (await deploy(s.ctx, s.input())).done).error).toMatch(
      /web:3000 never answered HTTP.*0\.0\.0\.0/,
    );
  });
});

describe("destroy", () => {
  test("file-less down from an empty directory, then routes, state, logs", async () => {
    const s = setup();
    const res = await deploy(s.ctx, s.input());
    await res.done;
    const gone = await destroy(s.ctx, res.preview.id, ACTOR);
    expect(gone.state).toBe("destroyed");
    expect(gone.destroyedAt).not.toBeNull();
    const down = s.calls.find((c) => c.argv.includes("down"))!;
    expect(down.argv).toEqual([
      "docker",
      "compose",
      "--project-name",
      "gw-default-web-app",
      "down",
      "-v",
      "--remove-orphans",
      "--rmi",
      "local",
    ]);
    // Then anything still labelled with the project, which a kept volume would be.
    expect(s.calls.slice(-2).map((c) => c.argv)).toEqual([
      [
        "docker",
        "volume",
        "ls",
        "--quiet",
        "--filter",
        "label=com.docker.compose.project=gw-default-web-app",
      ],
      [
        "docker",
        "image",
        "ls",
        "--quiet",
        "--filter",
        "dangling=true",
        "--filter",
        "label=com.docker.compose.project=gw-default-web-app",
      ],
    ]);
    expect(down.cwd).toContain("gangway-down-");
    expect(existsSync(down.cwd)).toBe(false);
    expect(s.table.size).toBe(0);
    expect(s.logs.read(res.preview.id)).toEqual([]);
    expect(s.events().slice(-2)).toEqual(["preview.state:destroying", "preview.state:destroyed"]);
    await expect(destroy(s.ctx, res.preview.id, ACTOR)).rejects.toMatchObject({ status: 404 });
  });

  test("if the daemon cannot confirm, NOTHING is released: routes and ports stay claimed", async () => {
    for (const down of [{ code: 1, stderr: "cannot connect" }, "throw"] as const) {
      const s = setup({ down });
      const res = await deploy(s.ctx, s.input());
      await res.done;
      await expect(destroy(s.ctx, res.preview.id, ACTOR)).rejects.toMatchObject({ status: 502 });
      expect(s.previews.get(res.preview.id)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("destroy failed"),
      });
      expect(s.table.usedPorts("127.0.0.1")).toEqual(new Set([31000]));
    }
  });

  test("destroying a deploy that is still running cancels it first, and it does not fight back", async () => {
    const s = setup({ up: { code: 0, hang: true } });
    const res = await deploy(s.ctx, s.input());
    await Bun.sleep(20);
    expect(s.previews.get(res.preview.id)!.state).toBe("starting");
    const gone = await destroy(s.ctx, res.preview.id, ACTOR);
    expect(gone.state).toBe("destroyed");
    await res.done;
    expect(s.previews.get(res.preview.id)!.state).toBe("destroyed");
    expect(s.calls.map((c) => c.cmd)).toEqual(["config", "up", "down"]);
  });

  test("a second destroy while the first is in flight is a 409", async () => {
    const s = setup();
    const res = await deploy(s.ctx, s.input());
    await res.done;
    const first = destroy(s.ctx, res.preview.id, ACTOR);
    await expect(destroy(s.ctx, res.preview.id, ACTOR)).rejects.toMatchObject({ status: 409 });
    await first;
  });
});

test("state machine: the legal edges, and the ones that must never exist", () => {
  expect(canTransition("building", "starting")).toBe(true);
  expect(canTransition("destroying", "failed")).toBe(true);
  expect(canTransition("failed", "destroying")).toBe(true);
  expect(canTransition("destroyed", "building")).toBe(false);
  expect(canTransition("destroying", "awake")).toBe(false);
  expect(canTransition("building", "awake")).toBe(false);
});
