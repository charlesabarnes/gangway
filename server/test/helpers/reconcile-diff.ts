import { expect } from "bun:test";
import type { Preview, PreviewState, Route } from "@gangway/shared/domain";
import {
  GANGWAY_LABEL_VERSION,
  type Action,
  type DiffInput,
  type ScannedContainer,
  type ScannedLabels,
} from "../../src/reconcile/diff.ts";

export const NOW = 1_700_000_000_000;
export const HOST = "h1";

export const mkPreview = (
  id: string,
  state: PreviewState = "awake",
  over: Partial<Preview> = {},
): Preview => ({
  id,
  project: `gw-${id}`,
  title: null,
  icon: null,
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

export const mkRoute = (
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

export const mkContainer = (
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

export const fullLabels = (
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

export const mkInput = (o: Partial<DiffInput> = {}): DiffInput => ({
  dbRoutes: [],
  previews: [],
  containers: [],
  hostReachable: true,
  now: NOW,
  ...o,
});

export const kinds = (a: readonly Action[]): string[] => a.map((x) => x.kind);

/** The one action of `kind`; fails the test if there is not exactly one. */
export const only = (a: readonly Action[], kind: Action["kind"]): Action => {
  const hit = a.filter((x) => x.kind === kind);
  expect(hit).toHaveLength(1);
  return hit[0]!;
};
