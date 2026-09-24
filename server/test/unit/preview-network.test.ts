import { describe, expect, test } from "bun:test";
import { buildStack, parseComposeModel } from "../../src/previews/compose-model.ts";
import { sharedNetworkFor } from "../../src/previews/stack-file.ts";
import { deployFiles, edit, setupRuntimes } from "../helpers/runtimes-fixtures.ts";

// What compose config resolves: every stack lists its default network.
const one = {
  services: { web: { image: "nginx", networks: { default: null } } },
  networks: { default: { name: "gw-x_default" } },
};
const two = {
  services: { web: { image: "nginx" }, db: { image: "postgres" } },
  networks: { default: { name: "gw-x_default" } },
};
const model = (doc: unknown) => parseComposeModel("gw-x", doc);
const tarball = (network?: "shared" | "isolated") => ({
  kind: "tarball" as const,
  uploadId: "u",
  ...(network ? { network } : {}),
});

describe("which network a preview joins", () => {
  test("auto: one service shares, several keep their own", () => {
    expect(sharedNetworkFor("tower", model(one), tarball())).toBe("gw-tower-previews");
    expect(sharedNetworkFor("tower", model(two), tarball())).toBeNull();
  });

  test("a stack that declares its own networks keeps them", () => {
    const own = { ...one, networks: { ...one.networks, back: {} } };
    expect(sharedNetworkFor("tower", model(own), tarball())).toBeNull();
  });

  test("isolated always gets its own network", () => {
    expect(sharedNetworkFor("tower", model(one), tarball("isolated"))).toBeNull();
  });

  test("shared is refused for several services", () => {
    expect(() => sharedNetworkFor("tower", model(two), tarball("shared"))).toThrow(
      "network: shared is for a single service",
    );
  });

  test("the stack joins the external network as its default", () => {
    const text = buildStack({
      resolved: one,
      planProject: "gw-x",
      model: model(one),
      routes: [],
      createdAt: new Date(0),
      ctx: { instance: "t", env: "dev", project: "gw-a", hostId: "local", visibility: "public" },
      publishBind: "127.0.0.1",
      origin: { scheme: "https", port: 8443 },
      sharedNetwork: "gw-t-shared",
    });
    expect(JSON.parse(text).networks).toEqual({
      default: { name: "gw-t-shared", external: true },
    });
  });
});

describe("deploying on the shared network", () => {
  test("a static upload makes sure the shared network exists and records auto", async () => {
    const s = setupRuntimes();
    const res = await deployFiles(s, { "index.html": "hi" }, "static");
    await res.done;
    const inspected = s.fake.all.some(
      (a) => a.includes("network") && a.includes("inspect") && a.includes("gw-default-previews"),
    );
    expect(inspected).toBe(true);
    expect(res.preview.source).not.toHaveProperty("network");
  });

  test("previews on the shared network cannot reach each other", async () => {
    const s = setupRuntimes();
    const creates = networkCalls(s);
    await (
      await deployFiles(s, { "index.html": "hi" }, "static")
    ).done;
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("com.docker.network.bridge.enable_icc=false");
    expect(creates[0]?.at(-1)).toBe("gw-default-previews");
  });

  test("an engine without that option still gets a shared network, and says so", async () => {
    const s = setupRuntimes();
    const creates = networkCalls(s, { refuseIcc: true });
    const res = await deployFiles(s, { "index.html": "hi" }, "static");
    await res.done;
    expect(creates).toHaveLength(2);
    expect(creates[1]).not.toContain("com.docker.network.bridge.enable_icc=false");
    expect(s.ctx.previews.get(res.preview.id)?.state).toBe("awake");
  });

  test("a rebuild on the shared network drops the old per-project network", async () => {
    const s = setupRuntimes();
    const res = await deployFiles(s, { "index.html": "hi" }, "static", "moved");
    await res.done;
    await edit(s, res.preview.id, { "index.html": "again" });
    const dropped = (name: string) => s.fake.all.some((a) => a.includes("rm") && a.includes(name));
    expect(dropped(`${res.preview.project}_default`)).toBe(true);
    expect(dropped("gw-default-shared")).toBe(true);
  });
});

/** Make the shared network missing, so the deploy creates it; returns every create argv. */
function networkCalls(s: ReturnType<typeof setupRuntimes>, o: { refuseIcc?: boolean } = {}) {
  const creates: string[][] = [];
  const capture = s.ctx.compose.capture.bind(s.ctx.compose);
  s.ctx.compose.capture = async (argv, host, opts) => {
    if (argv.includes("network") && argv.includes("inspect"))
      return { code: 1, stdout: "", stderr: "not found", signal: null };
    if (argv.includes("network") && argv.includes("create")) {
      creates.push(argv);
      if (o.refuseIcc && argv.includes("com.docker.network.bridge.enable_icc=false"))
        return { code: 1, stdout: "", stderr: "unsupported bridge network option", signal: null };
      return { code: 0, stdout: "", stderr: "", signal: null };
    }
    return capture(argv, host, opts);
  };
  return creates;
}
