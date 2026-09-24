import type { AddonChoice } from "./addons.ts";
import type { RuntimeId } from "./runtimes.ts";
import type { Scope } from "./permissions.ts";

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
  createdAt: Date;
  updatedAt: Date;
};

export const NETWORK_CHOICES = ["auto", "shared", "isolated"] as const;
export type NetworkChoice = (typeof NETWORK_CHOICES)[number];
/** Absent means auto: shared when the stack is one service, its own network otherwise. */
export type PreviewNetwork = Exclude<NetworkChoice, "auto">;

export const BRAND_CHOICES = ["inherit", "on", "off"] as const;
export type BrandChoice = (typeof BRAND_CHOICES)[number];

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
      brand?: "on" | "off";
    }
  | { kind: "git"; repo: string; ref: string };

export type Preview = {
  id: string;
  project: string;
  title: string | null;
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
  createdAt: Date;
};

export type Session = {
  id: string;
  userId: string;
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
