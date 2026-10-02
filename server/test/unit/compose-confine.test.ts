import { describe, expect, test } from "bun:test";
import {
  buildStack,
  KEPT_CAPABILITIES,
  parseComposeModel,
} from "../../src/previews/compose-model.ts";
import { buildSecretViolations } from "../../src/previews/compose-policy.ts";

/** Shaped like the parsed output of a real `docker compose config`. */
const resolved = (services: Record<string, unknown>) => ({
  name: "gw-x",
  networks: { default: { name: "gw-x_default", ipam: {} } },
  services,
});
const violations = (services: Record<string, unknown>) =>
  parseComposeModel("gw-x", resolved(services), ["/x"]).violations;

describe("policy: nothing reaches the operator's other containers or the host", () => {
  test.each([
    ["pid: container:*", { pid: "container:plex" }],
    ["ipc: container:*", { ipc: "container:plex" }],
    ["uts: host", { uts: "host" }],
    ["network_mode: bridge", { network_mode: "bridge" }],
    ["network_mode: br0", { network_mode: "br0" }],
    ["volumes_from a container", { volumes_from: ["container:npm"] }],
    ["external_links", { external_links: ["npm:proxy"] }],
    ["cgroup_parent", { cgroup_parent: "/" }],
    ["device_cgroup_rules", { device_cgroup_rules: ["c 1:3 mr"] }],
    ["gpus", { gpus: "all" }],
    [
      "reserved devices",
      { deploy: { resources: { reservations: { devices: [{ capabilities: ["gpu"] }] } } } },
    ],
    ["oom_kill_disable", { oom_kill_disable: true }],
    ["a negative oom_score_adj", { oom_score_adj: -1000 }],
    ["use_api_socket", { use_api_socket: true }],
    ["a provider service", { provider: { type: "model" } }],
    ["a privileged hook", { post_start: [{ command: "id", privileged: true }] }],
    ["runtime", { runtime: "runc" }],
    ["isolation", { isolation: "hyperv" }],
    ["sysctls", { sysctls: { "net.ipv4.ip_forward": 1 } }],
    ["extra_hosts", { extra_hosts: ["metadata:169.254.169.254"] }],
    ["dns", { dns: ["10.0.0.1"] }],
    ["dns as a string", { dns: "10.0.0.1" }],
    ["dns_search", { dns_search: ["corp.lan"] }],
    ["dns_opt", { dns_opt: ["ndots:1"] }],
    ["storage_opt", { storage_opt: { size: "1G" } }],
    ["another preview's image", { image: "gw-main-shop-web" }],
    ["another preview's image, tagged", { image: "docker.io/library/gw-main-shop-web:latest" }],
    ["links to a container outside the preview", { links: ["npm:proxy"] }],
  ])("%s is refused", (_what, svc) => {
    expect(violations({ web: { image: "n", ...svc } })).toHaveLength(1);
  });

  test("the preview's own services and namespaces are fine", () => {
    const web = {
      image: "n",
      network_mode: "service:db",
      volumes_from: ["db", "db:ro"],
      links: ["db"],
      oom_score_adj: 500,
      post_start: [{ command: "id" }],
    };
    expect(violations({ web, db: { image: "pg" } })).toEqual([]);
    expect(violations({ web: { image: "n", network_mode: "none" } })).toEqual([]);
    expect(violations({ web: { image: "n", isolation: "default" } })).toEqual([]);
    expect(violations({ web: { image: "someone/gw-tools:1" } })).toEqual([]);
  });
});

describe("policy: only fields gangway knows are allowed", () => {
  const doc = (extra: Record<string, unknown>, svc: Record<string, unknown> = {}) =>
    parseComposeModel("gw-x", { ...resolved({ web: { image: "n", ...svc } }), ...extra }, ["/x"])
      .violations;

  test.each([
    ["a field Compose may add one day", { future_thing: true }, "future_thing"],
    ["logging", { logging: { driver: "syslog" } }, "logging is not allowed (gangway reads"],
    ["annotations", { annotations: { "io.kubernetes.cri-o.Devices": "/dev/sda" } }, "annotations"],
    ["a deploy field", { deploy: { placement: { constraints: ["x"] } } }, "deploy.placement"],
    [
      "a reserved device",
      { deploy: { resources: { reservations: { devices: [{}] } } } },
      "deploy.resources.reservations.devices",
    ],
    ["a build field", { build: { context: "/x", ssh: ["default"] } }, "build.ssh"],
    [
      "a bind option on a mount",
      { volumes: [{ type: "volume", source: "d", target: "/d", bind: { propagation: "shared" } }] },
      "volumes: bind",
    ],
    [
      "a network option",
      { networks: { default: { driver_opts: { x: "y" } } } },
      "networks.default.driver_opts",
    ],
  ])("%s on a service is refused by name", (_, svc, needle) => {
    expect(doc({}, svc)).toEqual([expect.stringContaining(needle)]);
  });

  test.each([
    ["a top-level section", { models: { m: { model: "ai/x" } } }, "models is not allowed"],
    [
      "addresses for a network",
      {
        networks: {
          default: { name: "gw-x_default", ipam: { config: [{ subnet: "192.168.1.0/24" }] } },
        },
      },
      'network "default": ipam is not allowed',
    ],
    [
      "bridge options",
      {
        networks: {
          default: {
            name: "gw-x_default",
            ipam: {},
            driver_opts: { "com.docker.network.bridge.name": "docker0" },
          },
        },
      },
      "driver_opts",
    ],
    ["a volume plugin", { volumes: { d: { driver: "local-persist" } } }, "only the local driver"],
  ])("%s is refused", (_, extra, needle) => {
    expect(doc(extra)).toEqual([expect.stringContaining(needle)]);
  });

  test("what compose config writes for an ordinary stack passes", () => {
    const web = {
      image: "n",
      command: ["node", "server.js"],
      environment: { A: "1" },
      networks: { default: null },
      ports: [{ mode: "ingress", target: 3000, protocol: "tcp" }],
      volumes: [{ type: "volume", source: "d", target: "/d", volume: {} }],
      healthcheck: { test: ["CMD", "true"], interval: "5s" },
      deploy: { resources: { limits: { memory: "512M" } }, restart_policy: { condition: "any" } },
      depends_on: { db: { condition: "service_started", required: true } },
      "x-gangway": { expose: true },
      entrypoint: null,
    };
    expect(
      parseComposeModel(
        "gw-x",
        {
          ...resolved({ web, db: { image: "pg" } }),
          volumes: { d: { name: "gw-x_d" } },
          "x-anything": 1,
        },
        ["/x"],
      ).violations,
    ).toEqual([]);
  });
});

describe("policy: builds get no host network, no privilege and no entitlements", () => {
  test("only the default or no network, and nothing privileged", () => {
    const build = (b: Record<string, unknown>) =>
      violations({ web: { build: { context: "/x", ...b } } });
    expect(build({ network: "default" })).toEqual([]);
    expect(build({ network: "none" })).toEqual([]);
    expect(build({ network: "host" })).toEqual([
      'service "web": build.network: host is not allowed',
    ]);
    expect(build({ network: "br0" })).toEqual(['service "web": build.network: br0 is not allowed']);
    expect(build({ privileged: true, entitlements: ["network.host"] })).toEqual([
      'service "web": build.entitlements is not allowed',
      'service "web": build.privileged is not allowed',
    ]);
  });

  test("no host names, no cache shared with the host or other previews, no tags", () => {
    const build = (b: Record<string, unknown>) =>
      violations({ web: { build: { context: "/x", ...b } } });
    expect(build({ extra_hosts: ["db:10.0.0.5"] })).toEqual([
      'service "web": build.extra_hosts is not allowed',
    ]);
    expect(
      build({ cache_from: ["type=local,src=/srv"], cache_to: ["type=local,dest=/srv"] }),
    ).toEqual([
      'service "web": build.cache_from is not allowed',
      'service "web": build.cache_to is not allowed',
    ]);
    expect(build({ isolation: "process" })).toEqual([
      'service "web": build.isolation is not allowed',
    ]);
    // Any tag, not only gw-*: one named node:24-alpine would replace the base every build uses.
    const tagsRefused = [
      'service "web": build.tags is not allowed (gangway names the images a preview builds)',
    ];
    expect(build({ tags: ["app:dev", "gw-main-shop-web"] })).toEqual(tagsRefused);
    expect(build({ tags: ["node:24-alpine"] })).toEqual(tagsRefused);
    expect(build({ tags: [] })).toEqual(tagsRefused);
  });
});

const LIMITS = { memoryBytes: 2 * 1024 ** 3, cpus: 2, pids: 1024, containers: 0 };

const stackOf = (services: Record<string, unknown>, limits = LIMITS) => {
  const input = resolved(services);
  const m = parseComposeModel("gw-x", input);
  return JSON.parse(
    buildStack({
      resolved: input,
      planProject: "gw-x",
      model: m,
      routes: [],
      createdAt: new Date(0),
      ctx: { instance: "t", env: "dev", project: "gw-a", hostId: "local", visibility: "public" },
      publishBind: "127.0.0.1",
      origin: { scheme: "https", port: 8443 },
      limits,
    }),
  );
};

describe("policy: a preview runs a bounded number of containers", () => {
  const sized = (services: Record<string, unknown>, containers: number) =>
    parseComposeModel("gw-x", resolved(services), ["/x"], { ...LIMITS, containers }).violations;

  test("replicas count, in either spelling, and the services with them are named", () => {
    const v = sized(
      {
        web: { image: "n", scale: 3 },
        worker: { image: "n", deploy: { replicas: 10_000 } },
        db: { image: "p" },
      },
      10,
    );
    expect(v[0]).toContain("10004 containers across 3 services");
    expect(v[0]).toContain("previews.limits.containers");
    expect(v.slice(1)).toEqual([
      expect.stringContaining('service "web": 3 replicas'),
      expect.stringContaining('service "worker": 10000 replicas'),
    ]);
  });

  test("too many services is refused even with no replicas", () => {
    const services = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`s${i}`, { image: "n" }]),
    );
    expect(sized(services, 10)).toEqual([
      expect.stringContaining("11 containers across 11 services"),
    ]);
  });

  test("up to the limit passes, a replica count of 0 starts nothing, and 0 turns it off", () => {
    expect(sized({ web: { image: "n", scale: 9 }, db: { image: "p" } }, 10)).toEqual([]);
    expect(sized({ web: { image: "n", deploy: { replicas: 0 } }, db: { image: "p" } }, 1)).toEqual(
      [],
    );
    expect(sized({ web: { image: "n", scale: 500 } }, 0)).toEqual([]);
  });
});

describe("policy: secrets never reach a build", () => {
  const secrets = { API_KEY: "sk-live-0123456789", FLAG: "on", PIN: "12345", EMPTY: "" };
  const build = (b: unknown) => resolved({ web: { image: "x", build: b } });
  const none = resolved({});
  const check = (resolvedBuild: unknown, askedBuild: unknown = {}) =>
    buildSecretViolations(build(resolvedBuild), build(askedBuild), secrets);

  test.each([
    ["an arg", { context: "/src", args: { KEY: "sk-live-0123456789" } }, "API_KEY"],
    [
      "part of an arg",
      { context: "/src", args: { URL: "https://x:sk-live-0123456789@h" } },
      "API_KEY",
    ],
    [
      "an inline Dockerfile",
      { context: "/src", dockerfile_inline: "FROM x\nENV K=sk-live-0123456789" },
      "API_KEY",
    ],
    ["a label", { context: "/src", labels: { f: "on" } }, "FLAG"],
    ["a label's name", { context: "/src", labels: { "sk-live-0123456789": "marker" } }, "API_KEY"],
  ])("a secret's value in %s is refused, by name only", (_, b, key) => {
    const v = check(b);
    expect(v).toEqual([expect.stringContaining(`the secret ${key}`)]);
    expect(v.join()).not.toContain("sk-live");
  });

  test.each([
    ["${PIN}", "ENV P=${PIN}"],
    ["$PIN", "ENV P=$PIN"],
    ["a default", "ENV P=${PIN:-0000}"],
    ["a nested default", "ENV P=${X:-${PIN}}"],
  ])("a reference by %s is refused whatever the value's length", (_, line) => {
    const v = check(
      {
        context: "/src",
        dockerfile_inline: `FROM x\n${line.replace(/\$\{?PIN[^}\n]*\}?/, "12345")}`,
      },
      { context: "/src", dockerfile_inline: `FROM x\n${line}` },
    );
    expect(v).toEqual([expect.stringContaining("the secret PIN")]);
  });

  test("short values must match whole; escaped and longer names are not references", () => {
    expect(check({ context: "/src", args: { MODE: "online" } })).toEqual([]);
    expect(
      check({}, { context: "/src", dockerfile_inline: "RUN echo $$PIN ${PINNED} $PIN_CODE" }),
    ).toEqual([]);
  });

  test("runtime environment is fine", () => {
    const env = resolved({ web: { image: "x", environment: { KEY: "sk-live-0123456789" } } });
    expect(buildSecretViolations(env, none, secrets)).toEqual([]);
  });
});

describe("buildStack confines every container", () => {
  const stack = (svc: Record<string, unknown>, limits = LIMITS) =>
    stackOf({ web: { image: "n", ...svc } }, limits).services.web;

  test("the operator's limits apply, with no swap past the memory limit", () => {
    expect(stack({})).toMatchObject({
      mem_limit: "2147483648",
      memswap_limit: "2147483648",
      cpus: 2,
      pids_limit: 1024,
    });
  });

  test("a tighter limit in the file wins, in either spelling, and ends up in one place", () => {
    const web = stack({
      mem_limit: "536870912",
      deploy: { resources: { limits: { cpus: 0.5, pids: 50 } }, restart_policy: {} },
    });
    expect(web).toMatchObject({ mem_limit: "536870912", cpus: 0.5, pids_limit: 50 });
    expect(web.deploy).toEqual({ restart_policy: {} });
  });

  test("a looser limit in the file is capped, and so is a reservation above it", () => {
    const web = stack({
      mem_limit: "8589934592",
      memswap_limit: "-1",
      pids_limit: -1,
      mem_reservation: "4294967296",
      deploy: { resources: { limits: { memory: "8589934592" } } },
    });
    expect(web).toMatchObject({
      mem_limit: "2147483648",
      memswap_limit: "2147483648",
      pids_limit: 1024,
      mem_reservation: "2147483648",
    });
    expect("deploy" in web).toBe(false);
  });

  test("0 turns a limit off, leaving the file's own", () => {
    const web = stack({ pids_limit: 200 }, { memoryBytes: 0, cpus: 0, pids: 0, containers: 0 });
    expect(web.pids_limit).toBe(200);
    for (const key of ["mem_limit", "memswap_limit", "cpus"]) {
      expect(key in web).toBe(false);
    }
  });

  test("no new privileges, and only a short list of capabilities is kept", () => {
    expect(stack({})).toMatchObject({
      security_opt: ["no-new-privileges:true"],
      cap_drop: ["ALL"],
      cap_add: [...KEPT_CAPABILITIES],
    });
    expect(stack({}).cap_add).not.toContain("NET_RAW");
  });

  test("a capability the file drops stays dropped, and dropping ALL keeps none", () => {
    expect(stack({ cap_drop: ["chown", "MKNOD"] }).cap_add).not.toContain("CHOWN");
    const none = stack({ cap_drop: ["ALL"] });
    expect(none.cap_drop).toEqual(["ALL"]);
    expect("cap_add" in none).toBe(false);
  });
});

describe("buildStack keeps each preview's names to itself", () => {
  test("compose's own labels from the file are dropped, on services, builds and volumes", () => {
    const doc = stackOf({
      web: {
        image: "n",
        labels: { "com.docker.compose.project": "gw-t-victim", keep: "1" },
        build: { context: "/x", labels: { "com.docker.compose.service": "db", ok: "2" } },
      },
    });
    const web = doc.services.web;
    expect(web.labels.keep).toBe("1");
    expect(Object.keys(web.labels).some((k: string) => k.startsWith("com.docker.compose."))).toBe(
      false,
    );
    expect(web.build.labels).toEqual({ ok: "2" });
  });

  test("a built image keeps compose's name, and a sibling that reused it follows", () => {
    const doc = stackOf({
      web: { build: { context: "/x" }, image: "app" },
      worker: { image: "app:latest" },
      db: { image: "postgres:16" },
    });
    expect("image" in doc.services.web).toBe(false);
    expect(doc.services.worker.image).toBe("gw-a-web");
    expect(doc.services.db.image).toBe("postgres:16");
  });
});
