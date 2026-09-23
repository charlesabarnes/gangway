import { describe, expect, test } from "bun:test";
import type { Preview, PreviewState, Route, Visibility } from "@gangway/shared/domain";
import {
  GANGWAY_LABEL_VERSION,
  diff,
  isMutating,
  type Action,
  type DiffInput,
  type ScannedContainer,
  type ScannedLabels,
} from "../../src/reconcile/diff.ts";

const NOW = 1_700_000_000_000;
const HOST = "h1";

const mkPreview = (
  id: string,
  state: PreviewState = "awake",
  over: Partial<Preview> = {},
): Preview => ({
  id,
  project: `gw-${id}`,
  hostId: HOST,
  kind: "preview",
  state,
  source: { kind: "manual", userId: "u1" },
  visibility: "public",
  ttlExpiresAt: null,
  idleAfterMs: null,
  secretLevel: null,
  templateId: null,
  projectId: null,
  password: "inherit",
  passwordLogin: "inherit",
  lastSeenAt: null,
  error: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  destroyedAt: null,
  ...over,
});

const mkRoute = (
  hostname: string,
  previewId: string,
  port: number,
  over: Partial<Route> = {},
): Route => ({
  hostname,
  previewId,
  service: "web",
  containerPort: 3000,
  upstream: { host: "10.0.0.2", port },
  primary: true,
  createdAt: new Date(NOW),
  ...over,
});

const mkContainer = (
  id: string,
  labels: ScannedLabels,
  over: Partial<ScannedContainer> = {},
): ScannedContainer => ({
  id,
  hostId: HOST,
  upstreamHost: "10.0.0.2",
  publishedPort: 40000,
  state: "running",
  labels,
  ...over,
});

const fullLabels = (
  previewId: string,
  hostname: string,
  over: Partial<ScannedLabels> = {},
): ScannedLabels => ({
  previewId,
  hostname,
  service: "web",
  containerPort: 3000,
  visibility: "public",
  primary: true,
  version: GANGWAY_LABEL_VERSION,
  ...over,
});

const mkInput = (o: Partial<DiffInput> = {}): DiffInput => ({
  dbRoutes: [],
  previews: [],
  containers: [],
  hostReachable: true,
  now: NOW,
  ...o,
});

const kinds = (a: readonly Action[]): string[] => a.map((x) => x.kind);
const only = (a: readonly Action[], kind: Action["kind"]): Action => {
  const hit = a.filter((x) => x.kind === kind);
  expect(hit).toHaveLength(1);
  return hit[0]!;
};

// --------------------------------------------------------------------------------------------
// The case table: one entry per situation the reconciler must decide.
// --------------------------------------------------------------------------------------------

type Case = readonly [name: string, input: DiffInput, assert: (a: Action[]) => void];

const CASES: readonly Case[] = [
  [
    "route exists + container running on the recorded port -> verify and continue, restart nothing",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1")],
      containers: [mkContainer("c1", fullLabels("p1", "a.example.com"), { publishedPort: 40000 })],
    }),
    (a) => {
      expect(kinds(a)).toEqual(["LeaveAlone"]);
      expect(a[0]).toMatchObject({ kind: "LeaveAlone", reason: "in-sync", warn: false });
      expect(a.some(isMutating)).toBe(false);
    },
  ],
  [
    "route exists + container running on a DIFFERENT port -> UpdateUpstream",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1")],
      containers: [mkContainer("c1", fullLabels("p1", "a.example.com"), { publishedPort: 40777 })],
    }),
    (a) => {
      expect(a).toEqual([
        {
          kind: "UpdateUpstream",
          at: NOW,
          hostname: "a.example.com",
          previewId: "p1",
          containerId: "c1",
          from: { host: "10.0.0.2", port: 40000 },
          to: { host: "10.0.0.2", port: 40777 },
        },
      ]);
    },
  ],
  [
    "route exists + no container -> MarkAsleep, never a start",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1")],
    }),
    (a) => expect(a).toEqual([{ kind: "MarkAsleep", at: NOW, previewId: "p1" }]),
  ],
  [
    "route exists + container EXITED -> MarkAsleep, and the dead container is not an orphan",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1")],
      containers: [mkContainer("c1", fullLabels("p1", "a.example.com"), { state: "exited" })],
    }),
    (a) => {
      expect(kinds(a)).toEqual(["MarkAsleep", "LeaveAlone"]);
      expect(a[1]).toMatchObject({ reason: "container-exited" });
    },
  ],
  [
    "no route + running + complete labels + hostname unclaimed -> AdoptRoute from labels",
    mkInput({
      containers: [
        mkContainer("c1", fullLabels("p9", "new.example.com"), { publishedPort: 40123 }),
      ],
    }),
    (a) => {
      expect(a).toEqual([
        {
          kind: "AdoptRoute",
          at: NOW,
          containerId: "c1",
          hostId: HOST,
          hostname: "new.example.com",
          previewId: "p9",
          service: "web",
          containerPort: 3000,
          upstream: { host: "10.0.0.2", port: 40123 },
          primary: true,
          visibility: "public",
        },
      ]);
    },
  ],
  [
    "no route + running + labels incomplete -> StopOrphan",
    mkInput({
      containers: [
        mkContainer("c1", { previewId: "p9", hostname: "x.example.com" }), // no service/port
        mkContainer("c2", { hostname: "y.example.com", service: "web", containerPort: 3000 }), // no preview id
        mkContainer("c3", fullLabels("p9", "z.example.com", { containerPort: 0 })), // unparseable port
      ],
    }),
    (a) => {
      expect(kinds(a)).toEqual(["StopOrphan", "StopOrphan", "StopOrphan"]);
      for (const x of a) expect(x).toMatchObject({ reason: "incomplete-labels" });
    },
  ],
  [
    "no route + running + gangway.version HIGHER than ours -> LeaveAlone and warn",
    mkInput({
      containers: [
        mkContainer(
          "c1",
          fullLabels("p9", "new.example.com", { version: GANGWAY_LABEL_VERSION + 1 }),
        ),
      ],
    }),
    (a) => {
      expect(a).toEqual([
        {
          kind: "LeaveAlone",
          at: NOW,
          reason: "newer-gangway",
          hostname: "new.example.com",
          containerId: "c1",
          warn: true,
        },
      ]);
    },
  ],
  [
    "a newer gangway's container is left alone even when its labels are garbage",
    mkInput({ containers: [mkContainer("c1", { version: 99 })] }),
    (a) => expect(a).toMatchObject([{ kind: "LeaveAlone", reason: "newer-gangway" }]),
  ],
  [
    "preview in `building` + no container + no live build -> MarkFailed",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1", "building")],
    }),
    (a) => {
      expect(only(a, "MarkFailed")).toMatchObject({ kind: "MarkFailed", previewId: "p1" });
      expect(kinds(a)).toEqual(["MarkFailed"]);
    },
  ],
  [
    "preview in `building` WITH a live build -> left alone; reconciliation raced a real build",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1", "building")],
      liveBuilds: new Set(["p1"]),
    }),
    (a) => {
      expect(a.some(isMutating)).toBe(false);
      expect(a[0]).toMatchObject({ reason: "build-in-flight" });
    },
  ],
  [
    "two sources claim one hostname -> StopOrphan the container, SQLite wins",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1")],
      containers: [mkContainer("c-intruder", fullLabels("p2", "a.example.com"))],
    }),
    (a) => {
      // The route's own preview still has nothing running, so it also goes to sleep.
      expect(kinds(a).sort()).toEqual(["MarkAsleep", "StopOrphan"]);
      expect(only(a, "StopOrphan")).toMatchObject({
        kind: "StopOrphan",
        containerId: "c-intruder",
        hostname: "a.example.com",
        reason: "hostname-conflict",
      });
    },
  ],
  [
    "two unclaimed containers claim one hostname -> first adopted, the rest stopped",
    mkInput({
      containers: [
        mkContainer("c1", fullLabels("p1", "dup.example.com")),
        mkContainer("c2", fullLabels("p2", "dup.example.com")),
      ],
    }),
    (a) => {
      expect(kinds(a)).toEqual(["AdoptRoute", "StopOrphan"]);
      expect(a[0]).toMatchObject({ containerId: "c1" });
      expect(a[1]).toMatchObject({ containerId: "c2", reason: "hostname-conflict" });
    },
  ],
  [
    "route exists + HOST UNREACHABLE -> no action, no state change",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000), mkRoute("b.example.com", "p2", 40001)],
      previews: [mkPreview("p1"), mkPreview("p2", "building")],
      hostReachable: false,
    }),
    (a) => {
      expect(a.some(isMutating)).toBe(false);
      for (const x of a)
        expect(x).toMatchObject({ kind: "LeaveAlone", reason: "host-unreachable" });
    },
  ],
  [
    "a running container with complete labels but no published port -> StopOrphan, it cannot serve its hostname",
    mkInput({
      containers: [mkContainer("c1", fullLabels("p9", "new.example.com"), { publishedPort: null })],
    }),
    (a) => expect(a).toMatchObject([{ kind: "StopOrphan", reason: "unroutable" }]),
  ],
  [
    "an already-asleep preview is not re-slept",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1", "asleep")],
    }),
    (a) => expect(a).toMatchObject([{ kind: "LeaveAlone", reason: "already-asleep", warn: false }]),
  ],
  [
    "terminal previews are never revived or re-written",
    mkInput({
      dbRoutes: [
        mkRoute("a.example.com", "p1", 40000),
        mkRoute("b.example.com", "p2", 40001),
        mkRoute("c.example.com", "p3", 40002),
      ],
      previews: [
        mkPreview("p1", "failed"),
        mkPreview("p2", "destroying"),
        mkPreview("p3", "destroyed"),
      ],
    }),
    (a) => {
      expect(a.some(isMutating)).toBe(false);
      for (const x of a) expect(x).toMatchObject({ reason: "preview-inactive" });
    },
  ],
  [
    "a route whose preview row is missing is reported, not repaired",
    mkInput({ dbRoutes: [mkRoute("a.example.com", "ghost", 40000)] }),
    (a) => expect(a).toMatchObject([{ kind: "LeaveAlone", reason: "unknown-preview", warn: true }]),
  ],
  [
    "our container is running but the daemon reports no published port -> warn, change nothing",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1")],
      containers: [mkContainer("c1", fullLabels("p1", "a.example.com"), { publishedPort: null })],
    }),
    (a) => {
      expect(a.some(isMutating)).toBe(false);
      expect(a[0]).toMatchObject({ reason: "container-port-unknown", warn: true });
    },
  ],
  [
    "a preview whose host moved -> UpdateUpstream rewrites the address too, not just the port",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1")],
      containers: [
        mkContainer("c1", fullLabels("p1", "a.example.com"), { upstreamHost: "10.0.0.9" }),
      ],
    }),
    (a) =>
      expect(a).toMatchObject([{ kind: "UpdateUpstream", to: { host: "10.0.0.9", port: 40000 } }]),
  ],
  [
    "a preview with several routes is put to sleep exactly once",
    mkInput({
      dbRoutes: [
        mkRoute("a.example.com", "p1", 40000),
        mkRoute("b.example.com", "p1", 40001, { service: "api" }),
      ],
      previews: [mkPreview("p1")],
    }),
    (a) => expect(a).toEqual([{ kind: "MarkAsleep", at: NOW, previewId: "p1" }]),
  ],
  ["empty input -> no actions", mkInput(), (a) => expect(a).toEqual([])],
];

describe("the case table", () => {
  for (const [name, input, assert] of CASES) test(name, () => assert(diff(input)));
});

// --------------------------------------------------------------------------------------------
// The rule that matters most.
// --------------------------------------------------------------------------------------------

describe("an unreachable host is not an empty host", () => {
  const populated = (hostReachable: DiffInput["hostReachable"]): DiffInput =>
    mkInput({
      dbRoutes: Array.from({ length: 20 }, (_, i) =>
        mkRoute(`r${i}.example.com`, `p${i}`, 40000 + i),
      ),
      previews: Array.from({ length: 20 }, (_, i) =>
        mkPreview(`p${i}`, i % 3 === 0 ? "building" : "awake"),
      ),
      hostReachable,
    });

  test("a totally silent scan produces not one mutating action", () => {
    const a = diff(populated(false));
    expect(a).toHaveLength(20);
    expect(a.filter(isMutating)).toEqual([]);
  });

  test("the SAME input with the host reachable is full of them -- the difference is knowledge, not data", () => {
    expect(diff(populated(true)).filter(isMutating).length).toBe(20);
  });

  test("a host absent from the reachability map defaults to unreachable", () => {
    // "I could not ask" is the safe default; an empty map must never read as "everything is gone".
    const a = diff(populated(new Map()));
    expect(a.filter(isMutating)).toEqual([]);
  });

  test("reachability is per host: one dead daemon does not freeze the others", () => {
    const input = mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000), mkRoute("b.example.com", "p2", 40001)],
      previews: [
        mkPreview("p1", "awake", { hostId: "up" }),
        mkPreview("p2", "awake", { hostId: "down" }),
      ],
      hostReachable: new Map([
        ["up", true],
        ["down", false],
      ]),
    });
    const a = diff(input);
    expect(a.filter(isMutating)).toEqual([{ kind: "MarkAsleep", at: NOW, previewId: "p1" }]);
    expect(a.filter((x) => !isMutating(x))).toMatchObject([
      { reason: "host-unreachable", hostname: "b.example.com" },
    ]);
  });

  test("containers reported for an unreachable host are never stopped either", () => {
    const a = diff(
      mkInput({
        containers: [mkContainer("c1", {})],
        hostReachable: new Map([[HOST, false]]),
      }),
    );
    expect(a).toMatchObject([{ kind: "LeaveAlone", reason: "host-unreachable" }]);
  });
});

// --------------------------------------------------------------------------------------------
// Scale and determinism.
// --------------------------------------------------------------------------------------------

const consistentState = (n: number): DiffInput => {
  const dbRoutes: Route[] = [];
  const previews: Preview[] = [];
  const containers: ScannedContainer[] = [];
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(5, "0");
    const hostname = `p${id}.example.com`;
    const port = 40000 + i;
    dbRoutes.push(mkRoute(hostname, `p${id}`, port));
    previews.push(mkPreview(`p${id}`));
    containers.push(mkContainer(`c${id}`, fullLabels(`p${id}`, hostname), { publishedPort: port }));
  }
  return mkInput({ dbRoutes, previews, containers });
};

const shuffle = <T>(xs: readonly T[], rand: () => number): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

// Deterministic PRNG: a property test that cannot be replayed is not a test.
const mulberry32 =
  (seed: number): (() => number) =>
  () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

describe("scale", () => {
  test("100 routes and 100 containers all reconcile to no-ops", () => {
    const a = diff(consistentState(100));
    expect(a).toHaveLength(100);
    expect(a.filter(isMutating)).toEqual([]);
  });

  test("output order is a function of the data, not of scan order", () => {
    const base = consistentState(100);
    const rand = mulberry32(7);
    const shuffled = mkInput({
      dbRoutes: shuffle(base.dbRoutes, rand),
      previews: shuffle(base.previews, rand),
      containers: shuffle(base.containers, rand),
    });
    expect(diff(shuffled)).toEqual(diff(base));
    const seen = diff(base).map((x) => (x.kind === "LeaveAlone" ? x.hostname : null));
    expect(seen).toEqual(base.dbRoutes.map((r) => r.hostname));
  });

  test("stays linear: 20k routes and containers finish well inside a boot budget", () => {
    // A quadratic pass over this input is ~4e8 comparisons and would blow the bound by orders
    // of magnitude. Reconciliation runs on every boot and on every host reconnect.
    const big = consistentState(20_000);
    const started = performance.now();
    const a = diff(big);
    const elapsed = performance.now() - started;
    expect(a).toHaveLength(20_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});

// --------------------------------------------------------------------------------------------
// Idempotence: apply the diff, diff again, and nothing should be left to do.
// --------------------------------------------------------------------------------------------

/** A deliberately naive applier -- it only has to be faithful to what each action promises. */
const apply = (input: DiffInput, actions: readonly Action[]): DiffInput => {
  const routes = new Map(input.dbRoutes.map((r) => [r.hostname, { ...r }]));
  const previews = new Map(input.previews.map((p) => [p.id, { ...p }]));
  const containers = new Map(input.containers.map((c) => [c.id, { ...c }]));

  for (const a of actions) {
    if (a.kind === "UpdateUpstream") {
      routes.set(a.hostname, { ...routes.get(a.hostname)!, upstream: a.to });
    } else if (a.kind === "MarkAsleep") {
      previews.set(a.previewId, { ...previews.get(a.previewId)!, state: "asleep" });
    } else if (a.kind === "MarkFailed") {
      previews.set(a.previewId, { ...previews.get(a.previewId)!, state: "failed", error: a.error });
    } else if (a.kind === "AdoptRoute") {
      routes.set(a.hostname, {
        hostname: a.hostname,
        previewId: a.previewId,
        service: a.service,
        containerPort: a.containerPort,
        upstream: a.upstream,
        primary: a.primary,
        createdAt: new Date(NOW),
      });
      if (!previews.has(a.previewId)) {
        previews.set(
          a.previewId,
          mkPreview(a.previewId, "awake", { hostId: a.hostId, visibility: a.visibility }),
        );
      }
    } else if (a.kind === "StopOrphan") {
      containers.set(a.containerId, { ...containers.get(a.containerId)!, state: "exited" });
    }
  }
  return mkInput({
    dbRoutes: [...routes.values()],
    previews: [...previews.values()],
    containers: [...containers.values()],
  });
};

const STATES: readonly PreviewState[] = [
  "building",
  "starting",
  "awake",
  "asleep",
  "failed",
  "destroying",
  "destroyed",
];
const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private"];

/** A messy but plausible boot: some agreement, some drift, some junk. */
const randomState = (seed: number, n: number): DiffInput => {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const dbRoutes: Route[] = [];
  const previews: Preview[] = [];
  const containers: ScannedContainer[] = [];

  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(4, "0");
    const hostname = `p${id}.example.com`;
    const port = 40000 + i;
    const roll = rand();

    if (roll < 0.55) {
      // a route, with a container that may have drifted
      dbRoutes.push(mkRoute(hostname, `p${id}`, port));
      previews.push(mkPreview(`p${id}`, pick(STATES)));
      const r2 = rand();
      if (r2 < 0.5)
        containers.push(
          mkContainer(`c${id}`, fullLabels(`p${id}`, hostname), { publishedPort: port }),
        );
      else if (r2 < 0.7)
        containers.push(
          mkContainer(`c${id}`, fullLabels(`p${id}`, hostname), { publishedPort: port + 500 }),
        );
      else if (r2 < 0.85)
        containers.push(mkContainer(`c${id}`, fullLabels(`p${id}`, hostname), { state: "exited" }));
    } else if (roll < 0.8) {
      // an unclaimed container: adopt or stop
      const r2 = rand();
      const labels =
        r2 < 0.6
          ? fullLabels(`p${id}`, hostname, { visibility: pick(VISIBILITIES) })
          : r2 < 0.8
            ? { previewId: `p${id}` }
            : fullLabels(`p${id}`, hostname, { version: 5 });
      containers.push(mkContainer(`c${id}`, labels, { publishedPort: r2 < 0.55 ? port : null }));
    } else if (roll < 0.9) {
      // a route with nothing behind it
      dbRoutes.push(mkRoute(hostname, `p${id}`, port));
      previews.push(mkPreview(`p${id}`, pick(STATES)));
    } else {
      // a hostname two sources both claim
      dbRoutes.push(mkRoute(hostname, `p${id}`, port));
      previews.push(mkPreview(`p${id}`, "awake"));
      containers.push(
        mkContainer(`c${id}-x`, fullLabels(`other-${id}`, hostname), { publishedPort: port + 9 }),
      );
    }
  }
  return mkInput({ dbRoutes, previews, containers });
};

describe("idempotence", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i: applying the diff leaves nothing to do", (seed) => {
    const before = randomState(seed, 120);
    const first = diff(before);
    expect(first.some(isMutating)).toBe(true); // the fixture must actually be inconsistent

    const after = apply(before, first);
    const second = diff(after);
    expect(second.filter(isMutating)).toEqual([]);

    // ...and a third pass changes nothing either, so the fixed point is real.
    expect(diff(apply(after, second))).toEqual(second);
  });

  test("a consistent state is already a fixed point", () => {
    const state = consistentState(50);
    expect(diff(state).filter(isMutating)).toEqual([]);
    expect(diff(apply(state, diff(state)))).toEqual(diff(state));
  });

  test("diff mutates none of its inputs", () => {
    const state = randomState(42, 60);
    const snapshot = JSON.stringify(state, (_k, v: unknown) => (v instanceof Set ? [...v] : v));
    diff(state);
    expect(JSON.stringify(state, (_k, v: unknown) => (v instanceof Set ? [...v] : v))).toBe(
      snapshot,
    );
  });
});
