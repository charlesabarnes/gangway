import { describe, expect, test } from "bun:test";
import type { Preview, PreviewState, Route, Visibility } from "@gangway/shared/domain";
import {
  diff,
  isMutating,
  type Action,
  type DiffInput,
  type ScannedContainer,
} from "../../src/reconcile/diff.ts";
import { CASES } from "../helpers/reconcile-cases.ts";
import {
  fullLabels,
  HOST,
  mkContainer,
  mkInput,
  mkPreview,
  mkRoute,
  NOW,
} from "../helpers/reconcile-diff.ts";

describe("the case table", () => {
  for (const [name, input, assert] of CASES) test(name, () => assert(diff(input)));
});

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

  test("the same input with the host reachable mutates every preview", () => {
    expect(diff(populated(true)).filter(isMutating).length).toBe(20);
  });

  test("a host absent from the reachability map defaults to unreachable", () => {
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

// Seeded, so a failing property test can be replayed.
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
    // A quadratic pass here is ~4e8 comparisons and would blow the bound by orders of magnitude.
    const big = consistentState(20_000);
    const started = performance.now();
    const a = diff(big);
    const elapsed = performance.now() - started;
    expect(a).toHaveLength(20_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});

/** A deliberately naive applier: it only has to be faithful to what each action promises. */
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
