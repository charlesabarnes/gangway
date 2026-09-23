import { describe, expect, test } from "bun:test";
import type { ContainerSummary } from "../../src/docker/client-types.ts";
import { buildLabels, type GangwayLabels } from "../../src/docker/labels.ts";
import {
  classifyContainer,
  containerName,
  findPublishedPort,
  healthState,
  isReady,
  isRunning,
  parsePortKey,
  portDrift,
  publishedPorts,
  scanManaged,
} from "../../src/docker/inspect.ts";
import type { InspectJson } from "../../src/docker/inspect-json.ts";

const running: InspectJson = {
  Id: "c0ffee",
  Name: "/gw-acme-pr-123-api-1",
  Created: "2026-02-03T04:05:06.007Z",
  Config: { Image: "gw/acme:pr-123", Labels: { "com.docker.compose.service": "api" } },
  State: { Status: "running", Running: true, Health: { Status: "healthy", FailingStreak: 0 } },
  NetworkSettings: {
    Ports: {
      "8080/tcp": [
        { HostIp: "0.0.0.0", HostPort: "31042" },
        { HostIp: "::", HostPort: "31042" },
      ],
      "9229/tcp": null, // exposed but not published
      "5514/udp": [{ HostIp: "127.0.0.1", HostPort: "31099" }],
    },
  },
};

describe("port keys", () => {
  test("port/proto", () => {
    expect(parsePortKey("8080/tcp")).toEqual({ port: 8080, protocol: "tcp" });
    expect(parsePortKey("53/udp")).toEqual({ port: 53, protocol: "udp" });
    expect(parsePortKey("8080")).toEqual({ port: 8080, protocol: "tcp" });
  });

  test("nonsense keys are null, never a guess", () => {
    for (const k of ["", "/tcp", "abc/tcp", "0/tcp", "65536/tcp", "8080/quic", "8080/"]) {
      expect(parsePortKey(k)).toBeNull();
    }
  });
});

describe("publishedPorts", () => {
  test("flattens every binding and skips unpublished ports", () => {
    const ports = publishedPorts(running);
    expect(ports).toHaveLength(3);
    expect(ports.some((p) => p.containerPort === 9229)).toBe(false);
    expect(
      ports
        .filter((p) => p.containerPort === 8080)
        .map((p) => p.hostIp)
        .sort(),
    ).toEqual(["0.0.0.0", "::"]);
  });

  test("a container with nothing published yields nothing", () => {
    expect(publishedPorts({})).toEqual([]);
    expect(publishedPorts({ NetworkSettings: {} })).toEqual([]);
    expect(publishedPorts({ NetworkSettings: { Ports: null } })).toEqual([]);
    expect(publishedPorts({ NetworkSettings: { Ports: { "80/tcp": null } } })).toEqual([]);
  });

  test("a malformed HostPort is dropped rather than becoming NaN", () => {
    const ports = publishedPorts({
      NetworkSettings: {
        Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }, { HostIp: "0.0.0.0" }] },
      },
    });
    expect(ports).toEqual([]);
  });
});

describe("findPublishedPort", () => {
  // dockerd binds both families by default; taking the first listed would give "::" at random.
  test("prefers the binding matching Host.publishBind", () => {
    expect(findPublishedPort(running, 8080, { bind: "::" })?.hostIp).toBe("::");
    expect(findPublishedPort(running, 8080, { bind: "0.0.0.0" })?.hostIp).toBe("0.0.0.0");
  });

  test("falls back to the IPv4 binding when the bind address is unknown", () => {
    expect(findPublishedPort(running, 8080)?.hostIp).toBe("0.0.0.0");
    expect(findPublishedPort(running, 8080)?.hostPort).toBe(31042);
  });

  test("protocol is part of the identity", () => {
    expect(findPublishedPort(running, 5514)).toBeUndefined();
    expect(findPublishedPort(running, 5514, { protocol: "udp" })?.hostPort).toBe(31099);
  });

  test("an unpublished port is undefined, not port 0", () => {
    expect(findPublishedPort(running, 9229)).toBeUndefined();
    expect(findPublishedPort(running, 1234)).toBeUndefined();
  });
});

// Wake waits on health, so a service with no healthcheck must read as ready or wake hangs.
describe("health", () => {
  test("the three real statuses", () => {
    expect(healthState(running)).toBe("healthy");
    expect(healthState({ State: { Health: { Status: "starting" } } })).toBe("starting");
    expect(healthState({ State: { Health: { Status: "unhealthy" } } })).toBe("unhealthy");
  });

  test("no healthcheck declared is `none`, which is not unhealthy", () => {
    expect(healthState({ State: { Status: "running", Running: true } })).toBe("none");
    expect(healthState({ State: { Status: "running", Health: null } })).toBe("none");
    expect(healthState({})).toBe("none");
  });

  test("an unrecognised status is `unknown` rather than a crash", () => {
    expect(healthState({ State: { Health: { Status: "weird" } } })).toBe("unknown");
    expect(healthState({ State: { Health: {} } })).toBe("unknown");
  });

  test("isReady: running plus healthy-or-uncheckable", () => {
    expect(isReady(running)).toBe(true);
    expect(isReady({ State: { Running: true } })).toBe(true);
    expect(isReady({ State: { Running: true, Health: { Status: "starting" } } })).toBe(false);
    expect(isReady({ State: { Running: true, Health: { Status: "unhealthy" } } })).toBe(false);
    expect(isReady({ State: { Running: false, Health: { Status: "healthy" } } })).toBe(false);
    expect(isReady({})).toBe(false);
  });

  test("isRunning accepts either signal the daemon gives", () => {
    expect(isRunning({ State: { Running: true } })).toBe(true);
    expect(isRunning({ State: { Status: "running" } })).toBe(true);
    expect(isRunning({ State: { Status: "exited", Running: false } })).toBe(false);
  });

  test("container names lose their leading slash", () => {
    expect(containerName(running)).toBe("gw-acme-pr-123-api-1");
    expect(containerName({})).toBe("");
  });
});

describe("portDrift", () => {
  const route = { containerPort: 8080, upstream: { host: "10.0.0.4", port: 31042 } };

  test("agreement is null", () => {
    expect(portDrift(route, running, { bind: "0.0.0.0" })).toBeNull();
  });

  test("a moved port is reported with both values", () => {
    const moved: InspectJson = {
      NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "31777" }] } },
    };
    expect(portDrift(route, moved)).toEqual({ kind: "moved", expected: 31042, actual: 31777 });
  });

  test("a container that published nothing is distinguishable from one that moved", () => {
    expect(portDrift(route, { NetworkSettings: { Ports: { "8080/tcp": null } } })).toEqual({
      kind: "no-binding",
      expected: 31042,
    });
  });
});

const labels: GangwayLabels = {
  instance: "gw-main",
  env: "prod",
  previewId: "01HQ0000000000000000000000",
  project: "gw-acme-pr-123",
  service: "api",
  hostId: "docker-host",
  hostname: "acme-pr-123-api.preview.example.com",
  port: 31042,
  containerPort: 8080,
  upstreamHost: "10.0.0.4",
  visibility: "unlisted",
  primary: true,
  createdAt: new Date("2026-02-03T04:05:06.007Z"),
};

const summary = (over: Partial<ContainerSummary> = {}): ContainerSummary => ({
  id: "c0ffee",
  names: ["gw-acme-pr-123-api-1"],
  image: "gw/acme:pr-123",
  state: "running",
  status: "Up 2 minutes",
  labels: buildLabels(labels),
  ports: [],
  createdAt: new Date("2026-02-03T04:05:06.000Z"),
  ...over,
});

describe("scanning a daemon for our containers", () => {
  test("a managed container arrives with its route already rebuilt", () => {
    const row = classifyContainer(summary());
    expect("route" in row).toBe(true);
    if (!("route" in row)) throw new Error("unreachable");
    expect(row.route.upstream).toEqual({ host: "10.0.0.4", port: 31042 });
    expect(row.project).toBe("gw-acme-pr-123");
  });

  test("the compose project label wins for `project`, since that is the teardown unit", () => {
    const row = classifyContainer(
      summary({
        labels: { ...buildLabels(labels), "com.docker.compose.project": "gw-acme-pr-123" },
      }),
    );
    if (!("route" in row)) throw new Error("unreachable");
    expect(row.project).toBe("gw-acme-pr-123");
  });

  // Malformed means orphan (stop it); future-version means stranger (leave it alone).
  test("future-version and malformed stay separable in the scan output", async () => {
    const good = summary();
    const future = summary({
      id: "beef",
      labels: { ...buildLabels(labels), "gangway.version": "9" },
    });
    const broken = summary({
      id: "dead",
      labels: { "gangway.managed": "true", "gangway.version": "1" },
    });
    const foreign = summary({ id: "f00d", labels: { "org.opencontainers.image.title": "plex" } });

    const client = {
      hostId: "docker-host",
      listContainers: async () => [good, future, broken, foreign],
    };
    const scan = await scanManaged(client);

    expect(scan.hostId).toBe("docker-host");
    expect(scan.managed.map((m) => m.id)).toEqual(["c0ffee"]);
    expect(scan.unusable.map((u) => u.failure.reason).sort()).toEqual([
      "future-version",
      "malformed",
      "not-managed",
    ]);
    const stranger = scan.unusable.find((u) => u.id === "beef");
    expect(stranger?.failure.reason).toBe("future-version");
  });

  test("the scan asks the daemon to filter, and includes stopped containers", async () => {
    let seen: unknown;
    await scanManaged({
      hostId: "docker-host",
      listContainers: async (opts) => {
        seen = opts;
        return [];
      },
    });
    // A stopped container still owns its published-port allocation.
    expect(seen).toEqual({ all: true, filters: { label: ["gangway.managed=true"] } });
  });
});
