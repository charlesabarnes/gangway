/**
 * The domain model (spec §4), widened where the six-phase design needs it.
 *
 * Timestamps are epoch milliseconds at the storage boundary and `Date` in the domain.
 * Repositories do the conversion so nothing above them handles raw integers.
 */

export type HostCapability = "preview" | "runner";
export type UpstreamDial = "direct" | "socks5";
export type HostState = "unknown" | "ready" | "unreachable" | "error";

export type Host = {
  id: string;
  name: string;
  /** How we talk to the daemon. */
  dockerHost: string;
  /** Guard: `docker info`.Name must match this before we touch the daemon. */
  expectName: string | null;
  capabilities: HostCapability[];
  /** The IP dockerd binds published ports to. */
  publishBind: string;
  /** How the proxy reaches those published ports. Separate from publishBind by design. */
  upstream: { dial: UpstreamDial; address: string; proxy: string | null };
  ports: { rangeStart: number; rangeEnd: number };
  state: HostState;
  lastError: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

/**
 * §4 lists building|starting|awake|asleep|failed. `destroying` and `destroyed` are added
 * because teardown is not instantaneous and a half-destroyed preview must be
 * distinguishable from a live one by the reconciler.
 */
export type PreviewState =
  | "building" | "starting" | "awake" | "asleep" | "failed" | "destroying" | "destroyed";

export type Visibility = "public" | "unlisted" | "private";

/** §12.3: "A CI job is a preview with no route." */
export type PreviewKind = "preview" | "job";

export type PreviewSource =
  | { kind: "pr"; repo: string; number: number; sha: string }
  | { kind: "manual"; userId: string }
  | { kind: "agent"; tokenId: string; idempotencyKey: string }
  | { kind: "image"; image: string }
  | { kind: "tarball"; uploadId: string }
  | { kind: "git"; repo: string; ref: string };

export type Preview = {
  id: string;
  /** The compose project name, e.g. "gw-acme-pr-123". Namespaces containers, network and volumes. */
  project: string;
  hostId: string;
  kind: PreviewKind;
  state: PreviewState;
  source: PreviewSource;
  visibility: Visibility;
  ttlExpiresAt: Date | null;
  /** Written by the proxy on every request; the idle-sleep sweeper reads it. */
  lastSeenAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  destroyedAt: Date | null;
};

export type Route = {
  hostname: string;
  previewId: string;
  service: string;
  containerPort: number;
  upstream: { host: string; port: number };
  primary: boolean;
  createdAt: Date;
};

export type GangwayEvent = {
  seq: number;
  previewId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type Certificate = {
  domain: string;
  certPem: string;
  keyPem: string;
  chainPem: string | null;
  issuer: string | null;
  /** The ACME directory URL that issued it; null for anything else. */
  source: string | null;
  notBefore: Date | null;
  notAfter: Date | null;
  updatedAt: Date;
};

export const PREVIEW_ACTIVE_STATES: readonly PreviewState[] = [
  "building", "starting", "awake", "asleep",
];

export const isActive = (s: PreviewState): boolean => PREVIEW_ACTIVE_STATES.includes(s);
