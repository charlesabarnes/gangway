/**
 * The domain model (spec §4), widened where the six-phase design needs it.
 *
 * Timestamps are epoch milliseconds at the storage boundary and `Date` in the domain.
 * Repositories do the conversion so nothing above them handles raw integers.
 */
import type { Scope } from "./permissions.ts";

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

/** Where pull requests come from (ADR-0011). One so far; the union is the point. */
export type ForgeId = "github";
/** What a PR from a fork gets: nothing until asked (`ask`), a preview (`auto`), or never. */
export type ForkPolicy = "ask" | "auto" | "never";

/**
 * Secrets have a LEVEL; a preview has a CLEARANCE and receives every secret at or below
 * it (ADR-0012). `none` is a clearance only: no .env at all.
 */
export type SecretLevel = "low" | "standard" | "high";
export type Clearance = "none" | SecretLevel;
export const CLEARANCES: readonly Clearance[] = ["none", "low", "standard", "high"];
export const SECRET_LEVELS: readonly SecretLevel[] = ["low", "standard", "high"];
export const clears = (clearance: Clearance, level: SecretLevel): boolean => CLEARANCES.indexOf(clearance) >= CLEARANCES.indexOf(level);

/** A repository a forge has sent a pull request from, and how its previews are shaped. */
export type Repo = {
  id: string;
  forge: ForgeId;
  /** `owner/name` as the forge spells it. */
  fullName: string;
  installationId: string;
  /** The hostname stem: previews are `<slug>-pr-<n>`. Unique across repositories. */
  slug: string;
  enabled: boolean;
  disabledReason: string | null;
  /** null: the server default. */
  visibility: Visibility | null;
  ttl: string | null;
  forks: ForkPolicy;
  drafts: boolean;
  /** The clearance a same-repo PR is deployed with, and a fork's PR (ADR-0012). */
  prClearance: Clearance;
  forkClearance: Clearance;
  createdAt: Date;
  updatedAt: Date;
};

export type PreviewSource =
  | { kind: "pr"; repo: string; number: number; sha: string }
  | { kind: "manual"; userId: string }
  | { kind: "agent"; tokenId: string; idempotencyKey: string }
  | { kind: "image"; image: string }
  | { kind: "tarball"; uploadId: string }
  | { kind: "git"; repo: string; ref: string };

export type Preview = {
  id: string;
  /** The compose project name -- see `projectNameFor`. Namespaces containers, network and volumes. */
  project: string;
  hostId: string;
  kind: PreviewKind;
  state: PreviewState;
  source: PreviewSource;
  visibility: Visibility;
  ttlExpiresAt: Date | null;
  /** Idle-sleep after this long without a request (ADR-0012). null: the server default; 0: never. */
  idleAfterMs: number | null;
  /** The clearance this preview was deployed with; null when no repository was involved. */
  secretLevel: Clearance | null;
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

/* ------------------------------------------------------------------ accounts (§8) */

/** A named set of permissions. Which permissions is data: see `permissions.ts`. */
export type Role = {
  id: string;
  name: string;
  description: string;
  /** Shipped with gangway. `admin` is builtin AND immutable; the other two are editable. */
  builtin: boolean;
  createdAt: Date;
};

/** Never carries password material: that type exists only inside the server. */
export type User = {
  id: string;
  email: string;
  roleId: string;
  disabled: boolean;
  createdAt: Date;
};

export type Session = {
  /** sha256 of the cookie's secret -- the secret itself is never stored. */
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
  ip: string | null;
  userAgent: string | null;
};

/** §8.2. The secret is shown once at creation and is not part of this type. */
export type ApiToken = {
  id: string;
  name: string;
  /** The first characters of the secret, in clear, so a token can be recognised in a list. */
  prefix: string;
  scopes: Scope[];
  /** null for a token that belongs to no account (minted with the env admin token). */
  userId: string | null;
  appName: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type AuditActorType = "user" | "token" | "app" | "system" | "github";

/** §10.5.2. Append-only; `old`/`new` are redacted before they are written. */
export type AuditEntry = {
  seq: number;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  target: string | null;
  old: unknown;
  new: unknown;
  createdAt: Date;
};

export const PREVIEW_ACTIVE_STATES: readonly PreviewState[] = [
  "building", "starting", "awake", "asleep",
];

export const isActive = (s: PreviewState): boolean => PREVIEW_ACTIVE_STATES.includes(s);

/**
 * The compose project name for a preview: `gw-<instance>-<slug>`, e.g. `gw-tower-acme-pr-123`.
 *
 * The instance is IN the name, always, and not only for non-production. Two gangway
 * installations can drive one daemon (a laptop's dev run and the standing container on the
 * same host, §4.1); their reconcilers tell their containers apart by the `gangway.instance`
 * label, but compose keys on the project name alone: with `gw-<slug>` a dev deploy named like
 * a live preview RECREATED it. A mode flag ("prod omits the segment") would have been the
 * next thing to misconfigure, so there is none. The slug alone stays the hostname.
 */
export function projectNameFor(instance: string, slug: string): string {
  return `gw-${instance}-${slug}`;
}
