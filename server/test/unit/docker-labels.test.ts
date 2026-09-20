import { describe, expect, test } from "bun:test";
import type { Route, Visibility } from "../../../shared/src/domain.ts";
import {
  CURRENT_LABEL_VERSION, LABEL, buildLabels, containerLabels, isManaged,
  labelsFromRoute, parseLabels, routeFromLabels, type GangwayLabels,
} from "../../src/docker/labels.ts";

/* A tiny deterministic generator: property tests that change every run are tests that
   fail on someone else's branch for reasons nobody can reproduce. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const VISIBILITIES: Visibility[] = ["public", "unlisted", "private"];

function generate(rand: () => number): GangwayLabels {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const word = () => Math.floor(rand() * 1e9).toString(36);
  return {
    instance: `gw-${word()}`,
    env: pick(["prod", "dev", "staging", "ci"]),
    previewId: word().toUpperCase().padEnd(26, "Z"),
    project: `gw-${word()}-pr-${Math.floor(rand() * 9999)}`,
    service: pick(["api", "web", "worker", "db"]),
    hostId: pick(["local", "tower", "preview-host-2"]),
    hostname: `${word()}.preview.example.com`,
    port: 31000 + Math.floor(rand() * 500),
    containerPort: 1 + Math.floor(rand() * 65535),
    upstreamHost: pick(["127.0.0.1", "10.0.0.4", "tower.lan"]),
    visibility: pick(VISIBILITIES),
    primary: rand() < 0.5,
    createdAt: new Date(Math.floor(rand() * 1.7e12)),
  };
}

const sample: GangwayLabels = {
  instance: "gw-main",
  env: "prod",
  previewId: "01HQ0000000000000000000000",
  project: "gw-acme-pr-123",
  service: "api",
  hostId: "tower",
  hostname: "acme-pr-123-api.preview.example.com",
  port: 31042,
  containerPort: 8080,
  upstreamHost: "10.0.0.4",
  visibility: "unlisted",
  primary: true,
  createdAt: new Date("2026-02-03T04:05:06.007Z"),
};

describe("round trip", () => {
  test("parseLabels(buildLabels(x)) deep-equals x, for 500 generated inputs", () => {
    const rand = lcg(20260920);
    for (let i = 0; i < 500; i++) {
      const input = generate(rand);
      const parsed = parseLabels(buildLabels(input));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("unreachable");
      expect(parsed.labels).toEqual(input);
    }
  });

  test("every value is a string, because Docker labels are strings", () => {
    for (const v of Object.values(buildLabels(sample))) expect(typeof v).toBe("string");
  });

  test("the marker and version are written on every container", () => {
    const l = buildLabels(sample);
    expect(l[LABEL.managed]).toBe("true");
    expect(l[LABEL.version]).toBe(String(CURRENT_LABEL_VERSION));
    expect(isManaged(l)).toBe(true);
  });

  test("the spec's key list is present verbatim", () => {
    const l = buildLabels(sample);
    for (const key of [
      "gangway.managed", "gangway.version", "gangway.instance", "gangway.env",
      "gangway.preview_id", "gangway.project", "gangway.service", "gangway.host_id",
      "gangway.hostname", "gangway.port", "gangway.visibility", "gangway.primary",
      "gangway.created_at",
    ]) {
      expect(Object.hasOwn(l, key)).toBe(true);
    }
  });

  test("no label escapes the gangway namespace", () => {
    for (const k of Object.keys(buildLabels(sample))) expect(k.startsWith("gangway.")).toBe(true);
  });
});

/* This is the whole justification for §4.1. If a route cannot be rebuilt from labels
   alone, the daemon is not an independent second copy of state, and §11's third row
   ("no route / container running -> rebuild the route from labels") has no answer. */
describe("§4.1: the label set alone reconstructs a Route", () => {
  test("a Route survives a trip through labels with nothing else in hand", () => {
    const route: Route = {
      hostname: "acme-pr-123-api.preview.example.com",
      previewId: "01HQ0000000000000000000000",
      service: "api",
      containerPort: 8080,
      upstream: { host: "10.0.0.4", port: 31042 },
      primary: true,
      createdAt: new Date("2026-02-03T04:05:06.007Z"),
    };
    const ctx = {
      instance: "gw-main", env: "prod", project: "gw-acme-pr-123",
      hostId: "tower", visibility: "unlisted" as Visibility,
    };

    // The reconciler's inputs: a bag of strings off the daemon. No DB, no host record.
    const fromDaemon: Record<string, string> = JSON.parse(
      JSON.stringify(containerLabels(route, ctx)),
    ) as Record<string, string>;

    const parsed = parseLabels(fromDaemon);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(routeFromLabels(parsed.labels)).toEqual(route);
  });

  test("every Route field is covered for 200 generated routes", () => {
    const rand = lcg(7);
    for (let i = 0; i < 200; i++) {
      const g = generate(rand);
      const route = routeFromLabels(g);
      const rebuilt = routeFromLabels(labelsFromRoute(route, {
        instance: g.instance, env: g.env, project: g.project,
        hostId: g.hostId, visibility: g.visibility,
      }));
      expect(rebuilt).toEqual(route);
    }
  });
});

describe("failures are values, never throws", () => {
  test("an unlabelled container is not-managed", () => {
    expect(parseLabels({})).toEqual({ ok: false, reason: "not-managed" });
    expect(parseLabels(null)).toEqual({ ok: false, reason: "not-managed" });
    expect(parseLabels(undefined)).toEqual({ ok: false, reason: "not-managed" });
  });

  test("someone else's gangway-ish labels without the marker are not-managed", () => {
    const l = buildLabels(sample);
    delete l[LABEL.managed];
    expect(parseLabels(l)).toEqual({ ok: false, reason: "not-managed" });
  });

  test("gangway.managed must be exactly true", () => {
    for (const v of ["false", "1", "yes", "TRUE", ""]) {
      expect(parseLabels({ ...buildLabels(sample), [LABEL.managed]: v }).ok).toBe(false);
    }
  });

  test("a missing key is reported, not thrown", () => {
    const l = buildLabels(sample);
    delete l[LABEL.hostname];
    const r = parseLabels(l);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "malformed") throw new Error("expected malformed");
    expect(r.missing).toContain(LABEL.hostname);
    expect(r.invalid).toEqual([]);
  });

  test("garbage values are reported per key, all at once", () => {
    const r = parseLabels({
      ...buildLabels(sample),
      [LABEL.port]: "not-a-port",
      [LABEL.visibility]: "semi-public",
      [LABEL.primary]: "maybe",
      [LABEL.createdAt]: "the other day",
    });
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "malformed") throw new Error("expected malformed");
    expect(r.invalid.sort()).toEqual(
      [LABEL.createdAt, LABEL.port, LABEL.primary, LABEL.visibility].sort(),
    );
  });

  test("out-of-range ports are rejected rather than silently truncated", () => {
    for (const bad of ["0", "65536", "-1", "3.5", "31000 ", " 31000", "0x7a"]) {
      const r = parseLabels({ ...buildLabels(sample), [LABEL.port]: bad });
      expect(r.ok).toBe(false);
    }
  });

  test("an empty string is invalid, not missing", () => {
    const r = parseLabels({ ...buildLabels(sample), [LABEL.service]: "" });
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "malformed") throw new Error("expected malformed");
    expect(r.invalid).toContain(LABEL.service);
    expect(r.missing).not.toContain(LABEL.service);
  });

  test("parseLabels never throws, whatever is in the bag", () => {
    const hostile: Record<string, string>[] = [
      { [LABEL.managed]: "true" },
      { [LABEL.managed]: "true", [LABEL.version]: "" },
      { [LABEL.managed]: "true", [LABEL.version]: "one" },
      { [LABEL.managed]: "true", [LABEL.version]: "1", [LABEL.createdAt]: "0000-00-00" },
      { [LABEL.managed]: "true", [LABEL.version]: "1", [LABEL.port]: "٣١٠٠٠" },
      { [LABEL.managed]: "true", [LABEL.version]: "-1" },
      { [LABEL.managed]: "true", [LABEL.version]: "1.5" },
    ];
    for (const h of hostile) {
      expect(() => parseLabels(h)).not.toThrow();
      expect(parseLabels(h).ok).toBe(false);
    }
  });
});

/* §11: an orphan holding a port is worse than a missing preview, so the reconciler
   stops malformed containers. A container written by a NEWER gangway is not an orphan,
   it is a stranger, and stopping it would be the destructive version of this bug. */
describe("version skew", () => {
  test("a higher version is reported distinctly, not as malformed", () => {
    const r = parseLabels({ ...buildLabels(sample), [LABEL.version]: "2" });
    expect(r).toEqual({
      ok: false, reason: "future-version", version: 2, ours: CURRENT_LABEL_VERSION,
    });
  });

  test("a future version wins over missing keys, so we never call a stranger an orphan", () => {
    // A v2 gangway may legitimately have dropped keys v1 considers mandatory.
    const r = parseLabels({
      [LABEL.managed]: "true",
      [LABEL.version]: "9",
      [LABEL.hostname]: "x.preview.example.com",
    });
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "future-version") throw new Error("expected future-version");
    expect(r.version).toBe(9);
  });

  test("our own version parses", () => {
    expect(parseLabels({ ...buildLabels(sample), [LABEL.version]: String(CURRENT_LABEL_VERSION) }).ok)
      .toBe(true);
  });

  test("a missing version is malformed, not not-managed", () => {
    const l = buildLabels(sample);
    delete l[LABEL.version];
    const r = parseLabels(l);
    if (r.ok || r.reason !== "malformed") throw new Error("expected malformed");
    expect(r.missing).toEqual([LABEL.version]);
  });
});
