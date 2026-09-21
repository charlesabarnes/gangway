import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  buildStack, composeForImage, parseComposeModel, planRoutes, selectExposed,
  type ComposeModel,
} from "../../src/previews/compose-model.ts";
import { parseLabels } from "../../src/docker/labels.ts";
import { parseDuration } from "../../src/util/duration.ts";

/** Shaped like the parsed output of a real `docker compose config` (v2.22 and v2.29 agree). */
const resolved = (services: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  name: "gw-x",
  networks: { default: { name: "gw-x_default", ipam: {} } },
  services,
  ...extra,
});
const port = (target: number, published = String(target), protocol = "tcp") => ({ mode: "ingress", target, published, protocol });
const model = (services: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseComposeModel("gw-x", resolved(services, extra), ["/x"]);

const HOST = { id: "local", upstream: { dial: "direct" as const, address: "127.0.0.1", proxy: null }, ports: { rangeStart: 31000, rangeEnd: 31499 } };
const plan = (m: ComposeModel, slug = "acme") => planRoutes({
  previewId: "01J0000000000000000000000A", slug, baseDomain: "preview.example.com", host: HOST,
  exposed: selectExposed(m), allocate: (n) => Array.from({ length: n }, (_, i) => 31000 + i),
});

describe("parseComposeModel", () => {
  test("reads ports, expose, build, and the keys of networks and volumes", () => {
    const m = model({
      api: { image: "nginx", ports: [port(80, "3000"), port(9000, "9000", "udp")], expose: ["8080", "9090/tcp"] },
      web: { build: { context: "/x" } },
    }, { volumes: { data: { name: "gw-x_data" } } });
    expect(m.services[0]).toMatchObject({ name: "api", image: "nginx", hasBuild: false, publishedTargets: [80], exposed: [8080, 9090] });
    expect(m.services[1]).toMatchObject({ name: "web", image: null, hasBuild: true });
    expect(m.networks).toEqual(["default"]);
    expect(m.volumes).toEqual(["data"]);
    expect(m.violations).toEqual([]);
  });

  test("reads x-gangway from real `compose config` YAML, at both levels", () => {
    // Verbatim v2.29.2 output. YAML, because `--format json` drops the service-level key.
    const m = parseComposeModel("gw-plan", parseYaml(`
name: gw-plan
services:
  web:
    image: traefik/whoami:v1.10
    networks:
      default: null
    restart: unless-stopped
    x-gangway:
      expose: true
      port: 80
networks:
  default:
    name: gw-plan_default
x-gangway:
  ttl: 12h
`));
    expect(m.services[0]!.x).toEqual({ expose: true, port: 80 });
    expect(m.x).toEqual({ ttl: "12h" });
    expect(m.violations).toEqual([]);
  });

  test("x-gangway is strict: a typo is an error, not a silently ignored key", () => {
    expect(() => model({ api: { image: "n", "x-gangway": { exposed: true } } })).toThrow(/service "api": x-gangway/);
    expect(() => model({ api: { image: "n" } }, { "x-gangway": { ttl: "forever" } })).toThrow(/x-gangway\.ttl/);
    expect(() => model({})).toThrow(/no services/);
  });

  test("policy: every way out of the project namespace is named", () => {
    const m = model({
      bad: {
        image: "n", privileged: true, network_mode: "host", pid: "host", container_name: "fixed",
        devices: ["/dev/kvm"], cap_add: ["SYS_ADMIN"],
        volumes: [
          { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
          { type: "volume", source: "data", target: "/data" },
          { type: "tmpfs", target: "/tmp" },
        ],
      },
      sneaky: { image: "n", network_mode: "container:plex" },
    }, {
      networks: { default: { name: "gw-x_default" }, lan: { name: "br0", external: true }, mac: { name: "gw-x_mac", driver: "macvlan" } },
      volumes: { data: { name: "gw-x_data" }, host: { name: "gw-x_host", driver_opts: { type: "none", o: "bind", device: "/" } }, shared: { name: "appdata" } },
    });
    const v = m.violations.join("\n");
    for (const needle of ["privileged", "network_mode: host", "pid: host", "container_name", "devices", "cap_add",
      "bind mount of /var/run/docker.sock", "container:*", 'network "lan": external', 'network "lan": a custom name',
      'network "mac": only the bridge', 'volume "host": driver_opts', 'volume "shared": a custom name']) {
      expect(v).toContain(needle);
    }
    expect(m.violations.length).toBe(13);
  });
});

describe("selectExposed", () => {
  test("default: the single service that publishes a port", () => {
    expect(selectExposed(model({ db: { image: "pg" }, web: { image: "n", ports: [port(3000)] } })))
      .toEqual([{ service: "web", containerPort: 3000, subdomain: null, primary: false }]);
  });

  test("ambiguity is an error that names the fix", () => {
    expect(() => selectExposed(model({ a: { image: "n" } }))).toThrow(/nothing to expose/);
    expect(() => selectExposed(model({ a: { image: "n", ports: [port(1)] }, b: { image: "n", ports: [port(2)] } }))).toThrow(/ambiguous: a, b/);
    expect(() => selectExposed(model({ a: { image: "n", ports: [port(1), port(2)] } }))).toThrow(/ports 1, 2/);
    expect(() => selectExposed(model({ a: { image: "n", "x-gangway": { expose: true } } }))).toThrow(/declares no port/);
  });

  test("expose:false opts a publishing service out of the default", () => {
    const m = model({ db: { image: "pg", ports: [port(5432)], "x-gangway": { expose: false } }, web: { image: "n", ports: [port(80)] } });
    expect(selectExposed(m).map((e) => e.service)).toEqual(["web"]);
  });

  test("explicit: x-gangway.port wins, expose: entries count, one primary at most", () => {
    const m = model({
      api: { image: "n", expose: ["8080"], "x-gangway": { expose: true, subdomain: "backend" } },
      web: { image: "n", ports: [port(80), port(443)], "x-gangway": { expose: true, primary: true, port: 80 } },
      db: { image: "pg", ports: [port(5432)] },
    });
    expect(selectExposed(m)).toEqual([
      { service: "api", containerPort: 8080, subdomain: "backend", primary: false },
      { service: "web", containerPort: 80, subdomain: null, primary: true },
    ]);
    expect(() => selectExposed(model({
      a: { image: "n", "x-gangway": { expose: true, primary: true, port: 1 } },
      b: { image: "n", "x-gangway": { expose: true, primary: true, port: 2 } },
    }))).toThrow(/only one service may be primary/);
  });
});

describe("planRoutes (§6.2: flat labels, one wildcard)", () => {
  test("a single service drops its segment and is primary", () => {
    expect(plan(model({ web: { image: "n", ports: [port(3000)] } }))).toEqual([{
      hostname: "acme.preview.example.com", previewId: "01J0000000000000000000000A", service: "web",
      containerPort: 3000, upstream: { host: "127.0.0.1", port: 31000 }, primary: true,
    }]);
  });

  test("multi-service: primary is bare, others are suffixed by subdomain or service name", () => {
    const routes = plan(model({
      api: { image: "n", "x-gangway": { expose: true, subdomain: "backend", port: 1 } },
      web: { image: "n", "x-gangway": { expose: true, primary: true, port: 2 } },
      docs: { image: "n", "x-gangway": { expose: true, port: 3 } },
    }));
    expect(routes.map((r) => [r.hostname, r.upstream.port, r.primary])).toEqual([
      ["acme-backend.preview.example.com", 31000, false],
      ["acme.preview.example.com", 31001, true],
      ["acme-docs.preview.example.com", 31002, false],
    ]);
  });

  test("reserved and over-long labels are refused; colliding subdomains are refused", () => {
    const single = model({ web: { image: "n", ports: [port(1)] } });
    expect(() => plan(single, "api")).toThrow(/cannot build a hostname/);
    expect(() => plan(single, "x".repeat(64))).toThrow(/cannot build a hostname/);
    expect(() => plan(model({
      a: { image: "n", "x-gangway": { expose: true, subdomain: "same", port: 1 } },
      b: { image: "n", "x-gangway": { expose: true, subdomain: "same", port: 2 } },
    }))).toThrow(/same hostname/);
  });
});

describe("buildStack", () => {
  const input = resolved({
    web: {
      image: "n", ports: [port(3000)], command: ["sh", "-c", "echo $$HOSTNAME"],
      environment: { KEEP: "pa$$word", PUBLIC_URL: "http://localhost" },
      labels: { "traefik.enable": "true", "gangway.managed": "true", "gangway.preview_id": "SOMEONE-ELSES" },
    },
    db: { image: "pg", ports: [port(5432)], "x-gangway": { expose: false }, environment: ["POSTGRES_DB=app", "BARE"] },
  }, { volumes: { pgdata: { name: "gw-x_pgdata" } } });
  const before = structuredClone(input);
  const m = parseComposeModel("gw-x", input);
  const routes = plan(m);
  const text = buildStack({
    resolved: input, planProject: "gw-x", model: m, routes, createdAt: new Date("2026-09-20T00:00:00Z"),
    ctx: { instance: "default", env: "dev", project: "gw-acme", hostId: "local", visibility: "unlisted" },
    publishBind: "127.0.0.1", origin: { scheme: "https", port: 8443 }, extraEnv: { PRICE: "$5" },
  });
  const doc = JSON.parse(text);

  test("it is the user's resolved stack, untouched where we have no business", () => {
    expect(input).toEqual(before);
    expect(doc.services.web.image).toBe("n");
    // `$$` must survive verbatim: compose interpolates this file again when it runs it.
    expect(doc.services.web.command).toEqual(["sh", "-c", "echo $$HOSTNAME"]);
    expect(doc.services.web.environment.KEEP).toBe("pa$$word");
    expect(doc.services.db.environment).toMatchObject({ POSTGRES_DB: "app", BARE: null });
  });

  test("the routed service carries a label set the reconciler can rebuild the route from", () => {
    const parsed = parseLabels(doc.services.web.labels);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.labels).toMatchObject({ hostname: "acme.preview.example.com", port: 31000, containerPort: 3000, project: "gw-acme", visibility: "unlisted" });
  });

  test("a compose file cannot forge gangway.* labels; its other labels are kept", () => {
    expect(doc.services.web.labels["gangway.preview_id"]).toBe("01J0000000000000000000000A");
    expect(doc.services.web.labels["traefik.enable"]).toBe("true");
  });

  test("an unrouted service is OWNED but not MANAGED, so the reconciler never mistakes it for an orphan", () => {
    expect(doc.services.db.labels).toEqual({
      "gangway.instance": "default", "gangway.env": "dev", "gangway.project": "gw-acme", "gangway.preview_id": "01J0000000000000000000000A",
    });
    expect(parseLabels(doc.services.db.labels)).toEqual({ ok: false, reason: "not-managed" });
  });

  test("EVERY service's ports are replaced: ours moved into the pool, the rest removed", () => {
    expect(doc.services.web.ports).toEqual([{ mode: "ingress", host_ip: "127.0.0.1", target: 3000, published: "31000", protocol: "tcp" }]);
    expect("ports" in doc.services.db).toBe(false);
    expect(text).not.toContain("5432");
  });

  test("public URL env wins over the file's own, with $ escaped against interpolation", () => {
    expect(doc.services.web.environment).toMatchObject({
      PRICE: "$$5", GANGWAY_PREVIEW_ID: "01J0000000000000000000000A",
      GANGWAY_URL_WEB: "https://acme.preview.example.com:8443", PUBLIC_URL: "https://acme.preview.example.com:8443",
    });
    expect(doc.services.db.environment.PUBLIC_URL).toBe("https://acme.preview.example.com:8443");
  });

  test("names derived from the PLACEHOLDER project are dropped, or every preview shares one network", () => {
    expect(doc.name).toBe("gw-acme");
    expect("name" in doc.networks.default).toBe(false);
    expect("name" in doc.volumes.pgdata).toBe(false);
    expect(text).not.toContain("gw-x");
    expect(doc.networks.default.labels["gangway.project"]).toBe("gw-acme");
    expect(doc.volumes.pgdata.labels["gangway.preview_id"]).toBe("01J0000000000000000000000A");
  });
});

test("composeForImage is a one-service stack that round-trips through the model", () => {
  const text = composeForImage({ image: "nginx:alpine", port: 80, env: { A: "b$c" } });
  const doc = JSON.parse(text);
  expect(doc.services.web).toMatchObject({ image: "nginx:alpine", environment: { A: "b$$c" } });
  const m = parseComposeModel("gw-x", resolved({ web: doc.services.web }));
  expect(selectExposed(m)).toEqual([{ service: "web", containerPort: 80, subdomain: null, primary: false }]);
});

test("parseDuration", () => {
  expect(parseDuration("90s")).toBe(90_000);
  expect(parseDuration("7d")).toBe(604_800_000);
  expect(parseDuration("2w")).toBe(1_209_600_000);
  for (const bad of ["", "7", "d", "0d", "1.5h", "7 d", "-1d", "1y"]) expect(parseDuration(bad)).toBeNull();
});

describe("policy: nothing a build or a secret reads may come from outside the upload", () => {
  const violations = (services: Record<string, unknown>, extra: Record<string, unknown> = {}) => model(services, extra).violations;

  test("a build context inside the source is fine, with or without a dockerfile", () => {
    expect(violations({ web: { build: { context: "/x" } } })).toEqual([]);
    expect(violations({ web: { build: { context: "/x/services/web", dockerfile: "docker/Dockerfile.prod" } } })).toEqual([]);
    expect(violations({ web: { build: { context: "/x", dockerfile_inline: "FROM scratch" } } })).toEqual([]);
  });

  test.each([
    ["the filesystem root", { context: "/" }],
    ["a sibling whose name merely STARTS the same", { context: "/xy" }],
    ["a parent", { context: "/x/../etc" }],
    ["a git URL the daemon would fetch", { context: "https://github.com/evil/repo.git" }],
    ["nothing at all", {}],
  ])("build.context: %s is refused", (_what, build) => {
    expect(violations({ web: { build } })[0]).toContain("build.context must be a directory inside the uploaded source");
  });

  test("a dockerfile outside the context's tree is refused -- it is read from THIS machine", () => {
    expect(violations({ web: { build: { context: "/x", dockerfile: "../etc/passwd" } } })[0]).toContain("build.dockerfile");
    expect(violations({ web: { build: { context: "/x", dockerfile: "/etc/passwd" } } })[0]).toContain("build.dockerfile");
  });

  test("additional_contexts, build secrets and ssh forwarding are refused", () => {
    expect(violations({ web: { build: { context: "/x", additional_contexts: { host: "/" }, secrets: [{ source: "s" }], ssh: ["default"] } } })).toEqual([
      'service "web": build.additional_contexts is not allowed',
      'service "web": build.secrets is not allowed',
      'service "web": build.ssh is not allowed',
    ]);
  });

  test("with no source directory declared, NO build is allowed", () => {
    expect(parseComposeModel("gw-x", resolved({ web: { build: { context: "/x" } } })).violations.length).toBe(1);
  });

  test("secrets and configs: inline content only -- `file` reads the server's disk, `environment` reads gangway's own env", () => {
    expect(violations({ web: { image: "nginx" } }, { secrets: { ok: { content: "hunter2" } }, configs: { ok: { content: "a: 1" } } })).toEqual([]);
    const bad = violations({ web: { image: "nginx" } }, {
      secrets: { f: { file: "/x/secret.txt" }, e: { environment: "GANGWAY_ADMIN_TOKEN" }, x: { external: true } },
      configs: { f: { file: "/etc/shadow" } },
    });
    expect(bad.length).toBe(4);
    expect(bad[0]).toContain('secret "f": only inline `content:` is allowed');
  });
});
