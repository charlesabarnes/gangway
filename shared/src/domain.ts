import type { AddonChoice } from "./addons.ts";
import type { RuntimeId } from "./runtimes.ts";
import type { Scope, SecretTargets } from "./permissions.ts";
import type { PreviewIcon } from "./preview-icon.ts";

export type HostCapability = "preview" | "runner";
export type UpstreamDial = "direct" | "socks5";
export type HostState = "unknown" | "ready" | "unreachable" | "error";

export type Host = {
  id: string;
  name: string;
  dockerHost: string;
  // `docker info` Name must match this before anything touches the daemon.
  expectName: string | null;
  capabilities: HostCapability[];
  publishBind: string;
  upstream: { dial: UpstreamDial; address: string; proxy: string | null };
  ports: { rangeStart: number; rangeEnd: number };
  state: HostState;
  lastError: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

export type PreviewState =
  "building" | "starting" | "awake" | "asleep" | "failed" | "destroying" | "destroyed";

export type Visibility = "public" | "unlisted" | "private";

export type PasswordMode = "inherit" | "none" | "set" | "generated";

export type PasswordLogin = "inherit" | "on" | "off" | "only";

export type PreviewAccess = "open" | "password" | "signed-in" | "either" | "signed-in+password";

export type DefaultPasswordMode = "off" | "shared" | "generated";

export type PreviewKind = "preview" | "job";

export type ForgeId = "github";
export type ForkPolicy = "ask" | "auto" | "never";

export type SecretLevel = "low" | "standard" | "high";
export type Clearance = "none" | SecretLevel;
export const CLEARANCES: readonly Clearance[] = ["none", "low", "standard", "high"];
export const SECRET_LEVELS: readonly SecretLevel[] = ["low", "standard", "high"];
export const clears = (clearance: Clearance, level: SecretLevel): boolean =>
  CLEARANCES.indexOf(clearance) >= CLEARANCES.indexOf(level);

export type Template = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  visibility: Visibility;
  ttl: string | null;
  idleAfter: string;
  clearance: Clearance;
  hostId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Trigger = "pr" | "api" | "manual";
export const TRIGGERS: readonly Trigger[] = ["pr", "api", "manual"];

export type PrTrigger = "workflow" | "webhook";
export const PR_TRIGGERS: readonly PrTrigger[] = ["workflow", "webhook"];

export type Project = {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  forge: ForgeId | null;
  fullName: string | null;
  installationId: string;
  prTrigger: PrTrigger;
  enabled: boolean;
  disabledReason: string | null;
  templateId: string | null;
  visibility: Visibility | null;
  ttl: string | null;
  prClearance: Clearance | null;
  forks: ForkPolicy;
  drafts: boolean;
  forkClearance: Clearance;
  /** null follows the setting. */
  watermark: "on" | "off" | null;
  /** The wildcard domain its previews are named under; null follows the setting. */
  domain: string | null;
  productionPreviewId: string | null;
  deployBranch: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DomainKind = "wildcard" | "exact";
export type DomainStatus = "pending" | "active" | "failed";

/** A claimed name: a wildcard for previews, or one exact hostname; org-owned with neither id. */
export type Domain = {
  id: string;
  orgId: string;
  name: string;
  kind: DomainKind;
  projectId: string | null;
  previewId: string | null;
  status: DomainStatus;
  claimId: string;
  routingOk: boolean;
  lastError: string | null;
  checkedAt: Date | null;
  verifiedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const NETWORK_CHOICES = ["auto", "shared", "isolated"] as const;
export type NetworkChoice = (typeof NETWORK_CHOICES)[number];
/** Absent means auto: shared when the stack is one service, its own network otherwise. */
export type PreviewNetwork = Exclude<NetworkChoice, "auto">;

/** The gangway watermark on a preview: inherit follows the repository, then the setting. */
export const WATERMARK_CHOICES = ["inherit", "on", "off"] as const;
export type WatermarkChoice = (typeof WATERMARK_CHOICES)[number];

export type PullRequestRef = { repo: string; number: number; sha: string };
export type BranchRef = { repo: string; branch: string; sha: string };

export type PreviewSource =
  | { kind: "pr"; repo: string; number: number; sha: string; image?: string }
  | { kind: "manual"; userId: string }
  | { kind: "agent"; tokenId: string; idempotencyKey: string }
  | { kind: "image"; image: string; network?: PreviewNetwork }
  | {
      kind: "tarball";
      uploadId: string;
      runtime?: RuntimeId;
      addons?: AddonChoice[];
      network?: PreviewNetwork;
      /** "gangway": its files are served by gangway itself, with no container. */
      serve?: "gangway";
      /** The pull request whose workflow uploaded it. */
      pr?: PullRequestRef;
      branch?: BranchRef;
    }
  | { kind: "git"; repo: string; ref: string };

/** Whether gangway serves this preview's files itself instead of running a container. */
export const servedByGangway = (p: { source: PreviewSource }): boolean =>
  p.source.kind === "tarball" && p.source.serve === "gangway";

/** The pull request a preview was deployed for, whether gangway built it or a workflow sent it. */
export function pullRequestOf(s: PreviewSource): PullRequestRef | null {
  if (s.kind === "pr") {
    return s;
  }
  return s.kind === "tarball" ? (s.pr ?? null) : null;
}

export type Preview = {
  id: string;
  orgId: string;
  project: string;
  title: string | null;
  icon: PreviewIcon | null;
  hostId: string;
  kind: PreviewKind;
  state: PreviewState;
  source: PreviewSource;
  visibility: Visibility;
  ttlExpiresAt: Date | null;
  idleAfterMs: number | null;
  secretLevel: Clearance | null;
  templateId: string | null;
  projectId: string | null;
  password: PasswordMode;
  passwordLogin: PasswordLogin;
  watermark: WatermarkChoice;
  /** The wildcard domain chosen for this preview; null follows its project, then the setting. */
  domain: string | null;
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
  /** null: the server's own, seen only by the home org. */
  orgId: string | null;
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
  source: string | null;
  notBefore: Date | null;
  notAfter: Date | null;
  updatedAt: Date;
};

export type Role = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  createdAt: Date;
};

export type User = {
  id: string;
  email: string;
  roleId: string;
  disabled: boolean;
  /** Emailed a link to set a first password, and has not used it yet. */
  invited: boolean;
  createdAt: Date;
};

export type Session = {
  id: string;
  userId: string;
  orgId: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
  ip: string | null;
  userAgent: string | null;
};

export type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  secretTargets: SecretTargets | null;
  userId: string | null;
  appName: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type OAuthGrant = {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: Scope[];
  secretTargets: SecretTargets | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type AuditActorType = "user" | "token" | "app" | "system" | "github";

export type AuditEntry = {
  seq: number;
  actorType: AuditActorType;
  actorId: string | null;
  /** The agent's or API token's name, when the actor was a credential. */
  actorName: string | null;
  action: string;
  target: string | null;
  old: unknown;
  new: unknown;
  createdAt: Date;
};

// The instance stays in the name so two installs on one daemon never share a compose project.
export function projectNameFor(instance: string, slug: string): string {
  return `gw-${instance}-${slug}`;
}

export type RepoProject = Project & { forge: ForgeId; fullName: string };
export const hasRepo = (p: Project): p is RepoProject => p.forge !== null && p.fullName !== null;
