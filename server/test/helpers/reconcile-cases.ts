import { expect } from "bun:test";
import {
  GANGWAY_LABEL_VERSION,
  isMutating,
  type Action,
  type DiffInput,
} from "../../src/reconcile/diff.ts";
import {
  fullLabels,
  HOST,
  kinds,
  mkContainer,
  mkInput,
  mkPreview,
  mkRoute,
  NOW,
  only,
} from "./reconcile-diff.ts";

type Case = readonly [name: string, input: DiffInput, assert: (a: Action[]) => void];

/** One entry per situation the reconciler must decide. */
export const CASES: readonly Case[] = [
  [
    "a route and a container on the recorded port are left alone",
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
    "a container on a different port updates the route's upstream",
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
    "a route with no container is marked asleep, never started",
    mkInput({
      dbRoutes: [mkRoute("a.example.com", "p1", 40000)],
      previews: [mkPreview("p1")],
    }),
    (a) => expect(a).toEqual([{ kind: "MarkAsleep", at: NOW, previewId: "p1" }]),
  ],
  [
    "an exited container marks its preview asleep and is not an orphan",
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
    "an unrouted container with complete labels is adopted from them",
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
    "an unrouted container with incomplete labels is stopped",
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
    "a container from a newer gangway is left alone with a warning",
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
    "a building preview with no container and no live build is marked failed",
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
    "a building preview with a live build is left alone",
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
    "a container claiming a routed hostname is stopped; SQLite wins",
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
    "of two unrouted containers claiming a hostname, the first is adopted",
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
    "an unreachable host produces no action and no state change",
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
    "a labelled container with no published port is stopped as unroutable",
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
    "our running container with no published port warns and changes nothing",
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
    "a preview whose host moved gets a new upstream address, not just a port",
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
  ["empty input produces no actions", mkInput(), (a) => expect(a).toEqual([])],
];
