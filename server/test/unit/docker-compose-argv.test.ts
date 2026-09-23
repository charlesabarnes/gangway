import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors.ts";
import {
  NEUTRALISED_ENV,
  buildArgv,
  composeArgv,
  composeCapture,
  composeEnv,
  downArgv,
  parseComposePs,
  psArgv,
  runArgv,
  runCompose,
  upArgv,
  type ComposeEvent,
  type Spawner,
} from "../../src/docker/compose.ts";

const base = { project: "gw-acme-pr-123", files: ["/srv/gw/acme-pr-123/compose.yaml"] };

describe("composeArgv", () => {
  test("the shape of a basic invocation", () => {
    expect(composeArgv({ ...base, command: "up", args: ["-d"] })).toEqual([
      "docker",
      "compose",
      "--project-name",
      "gw-acme-pr-123",
      "--file",
      "/srv/gw/acme-pr-123/compose.yaml",
      "up",
      "-d",
    ]);
  });

  /* `docker compose up --project-name x` is a parse error and `docker compose up -f y`
     means something else entirely. Flag ORDER is the bug this file exists to prevent. */
  test("every global flag precedes the subcommand", () => {
    const argv = composeArgv({
      ...base,
      files: ["a.yaml", "b.yaml"],
      projectDirectory: "/srv/gw/acme-pr-123",
      envFiles: [".env", ".env.preview"],
      profiles: ["preview"],
      command: "up",
      args: ["-d"],
    });
    const cmd = argv.indexOf("up");
    for (const flag of [
      "--project-name",
      "--project-directory",
      "--file",
      "--env-file",
      "--profile",
    ]) {
      expect(argv.indexOf(flag)).toBeGreaterThan(-1);
      expect(argv.indexOf(flag)).toBeLessThan(cmd);
    }
    expect(argv.lastIndexOf("--file")).toBeLessThan(cmd);
    expect(argv.slice(cmd)).toEqual(["up", "-d"]);
  });

  test("compose files keep their order, because later files override earlier ones", () => {
    const argv = composeArgv({ ...base, files: ["base.yaml", "override.yaml"], command: "config" });
    expect(argv.join(" ")).toContain("--file base.yaml --file override.yaml");
  });

  test("the binary is overridable but defaults to docker", () => {
    expect(composeArgv({ ...base, command: "ps" })[0]).toBe("docker");
    expect(composeArgv({ ...base, command: "ps", docker: "/usr/local/bin/docker" })[0]).toBe(
      "/usr/local/bin/docker",
    );
  });

  test("optional groups are omitted entirely when absent", () => {
    const argv = composeArgv({ ...base, command: "ps" });
    expect(argv).not.toContain("--project-directory");
    expect(argv).not.toContain("--env-file");
    expect(argv).not.toContain("--profile");
  });
});

describe("composeArgv rejects what compose would mangle", () => {
  test("project names outside compose's own rule", () => {
    for (const p of ["Acme-PR-123", "acme pr 123", "-acme", "_acme", "acme/123", "", "acmé"]) {
      expect(() => composeArgv({ ...base, project: p, command: "up" })).toThrow(AppError);
    }
  });

  test("project names compose accepts are accepted", () => {
    for (const p of ["gw-acme-pr-123", "a", "0abc", "gw_acme_1", "gw-acme-pr-123-web"]) {
      expect(() => composeArgv({ ...base, project: p, command: "up" })).not.toThrow();
    }
  });

  test("no compose file at all is refused rather than defaulted", () => {
    // Defaulting would make compose pick up whatever ./compose.yaml is in cwd.
    expect(() => composeArgv({ ...base, files: [], command: "up" })).toThrow(/at least one/);
    // Teardown addresses the project by -p alone: a missing workdir cannot block it.
    expect(
      composeArgv({ ...base, files: [], command: "down", args: ["-v"] }).slice(1),
    ).not.toContain("--file");
  });

  test("a value beginning with - is refused, because every CLI reads it as a flag", () => {
    expect(() => composeArgv({ ...base, files: ["-rf.yaml"], command: "up" })).toThrow(AppError);
    expect(() => composeArgv({ ...base, command: "--version" })).toThrow(AppError);
    expect(() => composeArgv({ ...base, command: "up", projectDirectory: "-x" })).toThrow(AppError);
    expect(() => runArgv(base, "--rm-rf")).toThrow(AppError);
  });
});

describe("the five commands we actually run", () => {
  test("up is detached", () => {
    expect(upArgv(base).slice(-2)).toEqual(["up", "-d"]);
    expect(upArgv(base, ["--build"]).slice(-3)).toEqual(["up", "-d", "--build"]);
  });

  /* §7.1: teardown is `down -v`. Orphans go too, or a renamed service leaves a
     container squatting on its published port forever (§11's orphan case). */
  test("down removes volumes and orphans", () => {
    expect(downArgv(base).slice(-5)).toEqual(["down", "-v", "--remove-orphans", "--rmi", "local"]);
  });

  test("build uses plain progress, the only parseable mode, with services last", () => {
    expect(buildArgv(base, ["api", "web"]).slice(-4)).toEqual([
      "build",
      "--progress=plain",
      "api",
      "web",
    ]);
  });

  test("ps asks for json", () => {
    expect(psArgv(base).slice(-3)).toEqual(["ps", "--format", "json"]);
  });

  test("run is --rm, with the service before its command", () => {
    expect(runArgv(base, "api", ["./scripts/seed.sh"]).slice(-4)).toEqual([
      "run",
      "--rm",
      "api",
      "./scripts/seed.sh",
    ]);
    expect(runArgv(base, "api", ["sh", "-c", "echo hi"], ["-e", "SEED=1"]).slice(-8)).toEqual([
      "run",
      "--rm",
      "-e",
      "SEED=1",
      "api",
      "sh",
      "-c",
      "echo hi",
    ]);
  });
});

/* The environment is the whole reason this project has a safety story. On this machine
   `docker context ls` shows desktop-linux active, and DOCKER_CONTEXT beats DOCKER_HOST
   in the CLI's precedence order. Exporting DOCKER_HOST and leaving DOCKER_CONTEXT set
   deploys to the laptop and prints success. */
describe("composeEnv", () => {
  const ambient = {
    PATH: "/usr/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONTEXT: "desktop-linux",
    COMPOSE_PROJECT_NAME: "someone-elses-project",
    COMPOSE_FILE: "/home/dev/other/compose.yaml",
    COMPOSE_PROFILES: "debug",
    UNSET: undefined,
  };

  test("DOCKER_HOST comes from the host record, not the ambient environment", () => {
    const env = composeEnv({ dockerHost: "ssh://root@docker-host" }, ambient);
    expect(env["DOCKER_HOST"]).toBe("ssh://root@docker-host");
  });

  test("DOCKER_CONTEXT is set to the empty string, not merely left out", () => {
    const env = composeEnv({ dockerHost: "ssh://root@docker-host" }, ambient);
    expect(env["DOCKER_CONTEXT"]).toBe("");
    expect(Object.hasOwn(env, "DOCKER_CONTEXT")).toBe(true);
  });

  test("an inherited DOCKER_CONTEXT cannot survive in any form", () => {
    for (const ctx of ["desktop-linux", "default", "", "colima"]) {
      expect(
        composeEnv({ dockerHost: "tcp://docker-host:2375" }, { DOCKER_CONTEXT: ctx })[
          "DOCKER_CONTEXT"
        ],
      ).toBe("");
    }
  });

  test("ambient COMPOSE_* variables are neutralised, since we pass the explicit flags", () => {
    const env = composeEnv({ dockerHost: "ssh://root@docker-host" }, ambient);
    for (const k of NEUTRALISED_ENV) expect(env[k]).toBe("");
  });

  test("only what the docker CLI needs is inherited: the compose file is the SUBMITTER'S, and compose interpolates ${VAR} from this", () => {
    const env = composeEnv(
      { dockerHost: "ssh://root@docker-host" },
      {
        ...ambient,
        HOME: "/root",
        SSH_AUTH_SOCK: "/tmp/agent",
        GANGWAY_ADMIN_TOKEN: "gw_secret",
        GANGWAY_CF_API_TOKEN: "cf_secret",
        AWS_SECRET_ACCESS_KEY: "aws",
      },
    );
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/root", SSH_AUTH_SOCK: "/tmp/agent" });
    expect(JSON.stringify(env)).not.toMatch(/gw_secret|cf_secret|aws/);
    expect(Object.keys(env).filter((k) => k.startsWith("GANGWAY_"))).toEqual([]);
    expect(Object.hasOwn(env, "UNSET")).toBe(false);
    for (const v of Object.values(env)) expect(typeof v).toBe("string");
  });

  test("extra variables reach compose interpolation but cannot redirect the daemon", () => {
    const env = composeEnv(
      {
        dockerHost: "ssh://root@docker-host",
        extra: {
          GW_TAG: "pr-123",
          DOCKER_HOST: "unix:///var/run/docker.sock",
          DOCKER_CONTEXT: "desktop-linux",
        },
      },
      ambient,
    );
    expect(env["GW_TAG"]).toBe("pr-123");
    expect(env["DOCKER_HOST"]).toBe("ssh://root@docker-host");
    expect(env["DOCKER_CONTEXT"]).toBe("");
  });
});

/* ---------------------------------------------------------------- streaming */

const enc = new TextEncoder();

function streamFrom(gen: () => AsyncGenerator<string>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of gen()) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

type FakeOpts = {
  stdout?: () => AsyncGenerator<string>;
  stderr?: () => AsyncGenerator<string>;
  code?: number;
  onSpawn?: (argv: string[], env: Record<string, string>, cwd?: string) => void;
};

function fakeSpawner(o: FakeOpts): Spawner {
  const empty = async function* (): AsyncGenerator<string> {
    /* nothing */
  };
  return (argv, opts) => {
    o.onSpawn?.(argv, opts.env, opts.cwd);
    let done: () => void = () => {};
    const exited = new Promise<number>((resolve) => {
      done = () => resolve(o.code ?? 0);
    });
    const stdout = streamFrom(o.stdout ?? empty);
    const stderr = streamFrom(o.stderr ?? empty);
    // Resolve on the next turn so `exited` cannot win the race against the readers.
    queueMicrotask(() => setTimeout(done, 0));
    return { stdout, stderr, exited, kill: () => done(), signalCode: null };
  };
}

describe("runCompose", () => {
  test("yields lines then a single exit event carrying the code", async () => {
    const events: ComposeEvent[] = [];
    const spawner = fakeSpawner({
      stdout: async function* () {
        yield " Container gw-api-1  Started\n";
      },
      stderr: async function* () {
        yield "time=... level=warning\n";
      },
      code: 0,
    });
    for await (const ev of runCompose(
      upArgv(base),
      { dockerHost: "ssh://root@docker-host" },
      spawner,
    )) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === "line")).toHaveLength(2);
    const last = events.at(-1);
    expect(last).toEqual({ type: "exit", code: 0, signal: null });
    expect(events.filter((e) => e.type === "exit")).toHaveLength(1);
  });

  /* §5 step 4 streams build progress over SSE. A progress bar delivered after the build
     finishes is not progress, so this must deadlock rather than pass if the wrapper
     ever starts buffering to completion. */
  test("lines arrive incrementally, before the process has finished writing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spawner = fakeSpawner({
      stdout: async function* () {
        yield "#1 [internal] load build definition\n";
        await gate; // only resolved once the consumer saw line 1
        yield "#2 exporting layers\n";
      },
    });

    const seen: string[] = [];
    for await (const ev of runCompose(
      buildArgv(base),
      { dockerHost: "ssh://root@docker-host" },
      spawner,
    )) {
      if (ev.type !== "line") continue;
      seen.push(ev.line);
      if (seen.length === 1) release();
    }
    expect(seen).toEqual(["#1 [internal] load build definition", "#2 exporting layers"]);
  });

  test("stdout and stderr interleave rather than draining one at a time", async () => {
    let step1: () => void = () => {};
    let step2: () => void = () => {};
    const a = new Promise<void>((r) => {
      step1 = r;
    });
    const b = new Promise<void>((r) => {
      step2 = r;
    });
    const spawner = fakeSpawner({
      stdout: async function* () {
        yield "out-1\n";
        await b;
        yield "out-2\n";
      },
      stderr: async function* () {
        await a;
        yield "err-1\n";
        step2();
      },
    });

    const order: string[] = [];
    for await (const ev of runCompose(
      psArgv(base),
      { dockerHost: "ssh://root@docker-host" },
      spawner,
    )) {
      if (ev.type !== "line") continue;
      order.push(`${ev.stream}:${ev.line}`);
      if (order.length === 1) step1();
    }
    expect(order).toEqual(["stdout:out-1", "stderr:err-1", "stdout:out-2"]);
  });

  test("chunk boundaries do not split lines, and a trailing partial line is emitted", async () => {
    const spawner = fakeSpawner({
      stdout: async function* () {
        yield "hel";
        yield "lo\r\nwor";
        yield "ld\nno-newline";
      },
    });
    const lines: string[] = [];
    for await (const ev of runCompose(psArgv(base), { dockerHost: "x" }, spawner)) {
      if (ev.type === "line") lines.push(ev.line);
    }
    expect(lines).toEqual(["hello", "world", "no-newline"]);
  });

  test("a non-zero exit is reported, not thrown", async () => {
    const spawner = fakeSpawner({
      stderr: async function* () {
        yield "no such service\n";
      },
      code: 1,
    });
    const events: ComposeEvent[] = [];
    for await (const ev of runCompose(upArgv(base), { dockerHost: "x" }, spawner)) events.push(ev);
    expect(events.at(-1)).toEqual({ type: "exit", code: 1, signal: null });
  });

  test("the child is spawned with the guarded environment", async () => {
    let captured: Record<string, string> = {};
    const spawner = fakeSpawner({
      onSpawn: (_argv, env) => {
        captured = env;
      },
    });
    await composeCapture(
      upArgv(base),
      {
        dockerHost: "ssh://root@docker-host",
        baseEnv: { DOCKER_CONTEXT: "desktop-linux", DOCKER_HOST: "unix:///var/run/docker.sock" },
      },
      spawner,
    );
    expect(captured["DOCKER_HOST"]).toBe("ssh://root@docker-host");
    expect(captured["DOCKER_CONTEXT"]).toBe("");
  });

  test("preflight runs before the process exists, and a throw prevents the spawn", async () => {
    let spawned = false;
    const spawner = fakeSpawner({
      onSpawn: () => {
        spawned = true;
      },
    });
    const run = runCompose(
      upArgv(base),
      {
        dockerHost: "ssh://root@docker-host",
        preflight: async () => {
          throw new Error("refusing to use a Docker Desktop daemon");
        },
      },
      spawner,
    );
    await expect(run.next()).rejects.toThrow(/Docker Desktop/);
    expect(spawned).toBe(false);
  });

  test("composeCapture buffers for value-shaped output", async () => {
    const spawner = fakeSpawner({
      stdout: async function* () {
        yield '{"Name":"gw-api-1"}\n';
      },
      stderr: async function* () {
        yield "warn\n";
      },
      code: 0,
    });
    const r = await composeCapture(psArgv(base), { dockerHost: "x" }, spawner);
    expect(r).toEqual({ code: 0, stdout: '{"Name":"gw-api-1"}', stderr: "warn", signal: null });
  });
});

describe("parseComposePs", () => {
  const row = {
    Name: "gw-acme-pr-123-api-1",
    Service: "api",
    State: "running",
    Health: "healthy",
    ExitCode: 0,
    Publishers: [{ URL: "127.0.0.1", TargetPort: 8080, PublishedPort: 31042, Protocol: "tcp" }],
  };

  /* Compose changed this output mid-v2 and both shapes are in the wild on the same
     major version. We do not control which build is on a given host. */
  test("newline-delimited objects (compose >= 2.21)", () => {
    const out = parseComposePs(
      `${JSON.stringify(row)}\n${JSON.stringify({ ...row, Service: "web" })}\n`,
    );
    expect(out.map((r) => r.service)).toEqual(["api", "web"]);
    expect(out[0]?.publishers[0]?.publishedPort).toBe(31042);
  });

  test("a single JSON array (older compose)", () => {
    const out = parseComposePs(JSON.stringify([row, { ...row, Service: "web" }]));
    expect(out.map((r) => r.service)).toEqual(["api", "web"]);
  });

  test("empty output is an empty list, not an error", () => {
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("   \n ")).toEqual([]);
  });

  test("stray non-JSON lines are skipped rather than poisoning the parse", () => {
    const out = parseComposePs(`level=warning msg="..."\n${JSON.stringify(row)}\n`);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("gw-acme-pr-123-api-1");
  });

  test("a service with no healthcheck reports null health, not an empty string", () => {
    const out = parseComposePs(JSON.stringify({ ...row, Health: "" }));
    expect(out[0]?.health).toBeNull();
  });
});
