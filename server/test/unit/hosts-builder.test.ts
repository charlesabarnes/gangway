import { describe, expect, test } from "bun:test";
import { Builders } from "../../src/hosts/builder.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { tarball } from "../helpers/runtimes-fixtures.ts";

const sandboxed = { id: "pool-1", dockerHost: "ssh://gangway@10.0.0.5", runtime: "runsc" as const };
const NAME = "gw-test-build-01orga";

type Call = { argv: string[]; env: Record<string, string> };

function builders(o: { memory?: number; fail?: string } = {}) {
  const calls: Call[] = [];
  const state = {
    spec: "",
    memory: o.memory ?? 0,
    buildx: false,
    stopFailed: [] as string[],
    gate: Promise.resolve(),
  };
  const b = new Builders({
    instance: "test",
    stateDir: "/state",
    image: () => "moby/buildkit:rootless",
    memoryBytes: () => state.memory,
    run: async (argv, _dockerHost, env) => {
      calls.push({ argv, env });
      await state.gate;
      const verb = argv.slice(1, 3).join(" ");
      const ok = { code: 0, stdout: "", stderr: "", signal: null };
      if (o.fail && verb.startsWith(o.fail)) {
        return { ...ok, code: 1, stderr: "boom" };
      }
      if (verb.startsWith("inspect")) {
        return state.spec ? { ...ok, stdout: `${state.spec}\n` } : { ...ok, code: 1 };
      }
      if (argv[1] === "run") {
        state.spec = /gangway\.builder\.spec=(\w+)/.exec(argv.join(" "))?.[1] ?? "";
      }
      if (verb === "buildx inspect" && argv.length === 4) {
        return state.buildx ? ok : { ...ok, code: 1 };
      }
      if (verb === "buildx create") {
        state.buildx = true;
      }
      return ok;
    },
    onStopFailed: (name) => state.stopFailed.push(name),
  });
  const verbs = () => calls.map((c) => c.argv.slice(1, 3).join(" "));
  return { b, calls, state, verbs };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("org builders", () => {
  test("a host in Docker's own runtime builds in the daemon, as before", async () => {
    const { b, calls } = builders();
    expect(await b.acquire({ ...sandboxed, runtime: null }, "01ORGA")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("starts a rootless BuildKit in the host's runtime, on its own network", async () => {
    const { b, calls, verbs } = builders({ memory: 2 ** 30 });
    const lease = await b.acquire(sandboxed, "01ORGA");
    expect(lease?.args).toEqual(["--builder", NAME]);
    expect(lease?.env).toEqual({ BUILDX_CONFIG: "/state/buildx/pool-1" });
    expect(verbs()).toEqual([
      "inspect --format",
      "rm --force",
      "network create",
      "run --detach",
      "buildx inspect",
      "buildx create",
      "buildx inspect",
    ]);
    const run = calls.find((c) => c.argv[1] === "run")?.argv ?? [];
    const after = (flag: string) => run[run.indexOf(flag) + 1];
    expect(after("--runtime")).toBe("runsc");
    expect(after("--network")).toBe(NAME);
    expect(after("--cap-drop")).toBe("ALL");
    expect(after("--memory")).toBe(String(2 ** 30));
    expect(run).toContain("gangway.org=01ORGA");
    expect(run).not.toContain("--privileged");
    expect(run.at(-1)).toBe("--oci-worker-no-process-sandbox");
    expect(calls.every((c) => c.env["BUILDX_CONFIG"] === "/state/buildx/pool-1")).toBe(true);
  });

  test("stops when the org's last build lets go, and starts the same one again", async () => {
    const { b, verbs } = builders();
    const one = await b.acquire(sandboxed, "01ORGA");
    const two = await b.acquire(sandboxed, "01ORGA");
    one?.release();
    one?.release();
    await settle();
    expect(verbs()).not.toContain("stop --time");
    two?.release();
    await settle();
    expect(verbs().filter((v) => v === "stop --time")).toHaveLength(1);
    const before = verbs().length;
    await b.acquire(sandboxed, "01ORGA");
    expect(verbs().slice(before)).toEqual([
      "inspect --format",
      `start ${NAME}`,
      "buildx inspect",
      "buildx inspect",
    ]);
  });

  test("a changed memory limit recreates the builder", async () => {
    const { b, state, verbs } = builders();
    (await b.acquire(sandboxed, "01ORGA"))?.release();
    await settle();
    state.memory = 2 ** 31;
    const before = verbs().length;
    await b.acquire(sandboxed, "01ORGA");
    expect(verbs().slice(before)).toContain("run --detach");
  });

  test("a changed spec waits until no build is using the builder", async () => {
    const { b, state, verbs } = builders();
    const first = await b.acquire(sandboxed, "01ORGA");
    state.memory = 2 ** 31;
    const before = verbs().length;
    (await b.acquire(sandboxed, "01ORGA"))?.release();
    expect(verbs().slice(before)).toEqual([]);
    first?.release();
  });

  test("a cancelled build stops starting its builder", async () => {
    const { b, verbs } = builders();
    const ac = new AbortController();
    ac.abort();
    await expect(b.acquire(sandboxed, "01ORGA", ac.signal)).rejects.toThrow();
    await settle();
    expect(verbs()).toEqual(["stop --time"]);
  });

  test("a build cancelled while another starts the builder stops waiting", async () => {
    const { b, state } = builders();
    let finish = () => {};
    state.gate = new Promise<void>((r) => (finish = r));
    const first = b.acquire(sandboxed, "01ORGA");
    const ac = new AbortController();
    const second = b.acquire(sandboxed, "01ORGA", ac.signal);
    ac.abort();
    await expect(second).rejects.toThrow();
    finish();
    (await first)?.release();
  });

  test("a builder that will not start fails the build with the host and the reason", async () => {
    const { b, verbs } = builders({ fail: "run" });
    await expect(b.acquire(sandboxed, "01ORGA")).rejects.toThrow(
      /host "pool-1": could not start the org's builder \(docker run --detach exited 1\): boom/,
    );
    await settle();
    await settle();
    expect(verbs()).toContain("stop --time");
  });
  test("a build goes through the org's builder when there is one, then lets it go", async () => {
    const s = setupPreviewContext();
    const leases: { org: string; released: boolean }[] = [];
    s.ctx.builders = {
      acquire: async (_host, org) => {
        const lease = { org, released: false };
        leases.push(lease);
        return {
          args: ["--builder", "gw-test-build-org"],
          env: { BUILDX_CONFIG: "/state/buildx/local" },
          release: () => {
            lease.released = true;
          },
        };
      },
    };
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      visibility: "public",
      name: "boxed",
      source: {
        kind: "tarball",
        archive: await tarball({ Dockerfile: "FROM x" }),
        port: 80,
      },
    });
    expect(await res.done).toMatchObject({ state: "awake" });
    const build = s.fake.all.find((a) => a.includes("build")) ?? [];
    expect(build.slice(build.indexOf("--builder"), build.indexOf("--builder") + 2)).toEqual([
      "--builder",
      "gw-test-build-org",
    ]);
    expect(s.fake.buildEnvs[0]).toEqual({ BUILDX_CONFIG: "/state/buildx/local" });
    expect(leases).toEqual([{ org: res.preview.orgId, released: true }]);
  });
});
