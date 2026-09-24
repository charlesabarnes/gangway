import type { PreviewIcon } from './preview-icon.types';
export type {
  ArtifactAccent,
  ArtifactKind,
  ArtifactMeta,
  ArtifactTheme,
  BrandChoice,
} from './artifact.types';
export type { AppPlan, Command, PlanIssue, PlanReason, PlanRequest } from './plan.types';
export type PreviewState =
  'building' | 'starting' | 'awake' | 'asleep' | 'failed' | 'destroying' | 'destroyed';
export const PREVIEW_STATES: readonly PreviewState[] = [
  'building',
  'starting',
  'awake',
  'asleep',
  'failed',
  'destroying',
  'destroyed',
];

export type Visibility = 'public' | 'unlisted' | 'private';
export const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private'];

export type PreviewSource =
  | { kind: 'pr'; repo: string; number: number; sha: string }
  | { kind: 'manual'; userId: string }
  | { kind: 'agent'; tokenId: string; idempotencyKey: string }
  | { kind: 'image'; image: string }
  /** `runtime` absent: the upload brought its own compose file or Dockerfile. */
  | {
      kind: 'tarball';
      uploadId: string;
      runtime?: RuntimeId;
      addons?: AddonChoice[];
      network?: 'shared' | 'isolated';
      brand?: 'on' | 'off';
      /** gangway serves the files itself, with no container. */
      serve?: 'gangway';
    }
  | { kind: 'git'; repo: string; ref: string };
export type SourceKind = PreviewSource['kind'];

export type PreviewUrl = { service: string; url: string; primary: boolean };

export type PasswordMode = 'inherit' | 'none' | 'set' | 'generated';
export type PasswordChoice =
  { mode: 'inherit' } | { mode: 'none' } | { mode: 'generate' } | { mode: 'set'; value: string };
export type PasswordLogin = 'inherit' | 'on' | 'off' | 'only';
export type PreviewAccess = 'open' | 'password' | 'signed-in' | 'either' | 'signed-in+password';
export type PasswordChange = { password?: PasswordChoice; login?: PasswordLogin };
export type DefaultPasswordMode = 'off' | 'shared' | 'generated';

export type Preview = {
  id: string;
  project: string;
  title: string | null;
  icon: PreviewIcon | null;
  hostId: string;
  kind: 'preview' | 'job';
  state: PreviewState;
  source: PreviewSource;
  visibility: Visibility;
  ttlExpiresAt: string | null;
  idleAfterMs: number | null;
  secretLevel: Clearance | null;
  templateId: string | null;
  projectId: string | null;
  password: PasswordMode;
  passwordLogin: PasswordLogin;
  access: PreviewAccess;
  lastSeenAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  destroyedAt: string | null;
  urls: PreviewUrl[];
};

export type PreviewList = { seq: number; previews: Preview[] };

export type PreviewEvent = {
  seq: number;
  type: string;
  at: string;
  state?: PreviewState;
  from?: PreviewState;
  error?: string;
  phase?: RedeployPhase;
  buildId?: string;
  by?: string;
};

export type Build = {
  id: string;
  previewId: string;
  service: string | null;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
};

export type LogStream = 'system' | 'build' | 'seed' | 'stdout' | 'stderr';
export const LOG_STREAMS: readonly LogStream[] = ['system', 'build', 'seed', 'stdout', 'stderr'];
export type LogLine = { n: number; at: string; stream: LogStream; line: string };

export type StreamEvent =
  | { type: 'preview.created'; previewId: string; at: string }
  | { type: 'preview.adopted'; previewId: string; at: string }
  | {
      type: 'preview.state';
      previewId: string;
      at: string;
      state: PreviewState;
      from: PreviewState;
      error?: string;
    }
  | {
      type: 'preview.redeploy';
      previewId: string;
      at: string;
      phase: RedeployPhase;
      buildId: string;
      by: string;
      error?: string;
    }
  | { type: 'reset'; at: string };
export const STREAM_EVENT_TYPES = [
  'preview.created',
  'preview.adopted',
  'preview.state',
  'preview.redeploy',
  'reset',
] as const;

export const PERMISSIONS = [
  'previews.read',
  'previews.read_own',
  'previews.deploy',
  'previews.deploy_static',
  'previews.destroy',
  'previews.destroy_own',
  'previews.update',
  'previews.update_own',
  'previews.data',
  'previews.view_private',
  'previews.skip_password',
  'logs.read',
  'events.read',
  'hosts.read',
  'hosts.manage',
  'tokens.manage_own',
  'tokens.manage_all',
  'users.read',
  'users.manage',
  'roles.read',
  'roles.manage',
  'audit.read',
  'settings.read',
  'settings.write',
  'surfaces.manage',
  'github.manage',
  'repos.manage',
  'repos.secrets',
  'templates.manage',
  'apps.read',
  'apps.install',
  'jobs.claim',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type Scope = 'read' | 'deploy' | 'update' | 'artifacts' | 'admin';
export const SCOPES: readonly Scope[] = ['read', 'deploy', 'update', 'artifacts', 'admin'];

const READ_BUNDLE: readonly Permission[] = [
  'previews.read',
  'logs.read',
  'events.read',
  'hosts.read',
];
export const SCOPE_PERMISSIONS: Record<Scope, readonly Permission[]> = {
  read: READ_BUNDLE,
  deploy: [...READ_BUNDLE, 'previews.deploy', 'previews.destroy_own', 'previews.update_own'],
  update: ['previews.update'],
  artifacts: [
    'previews.read_own',
    'previews.deploy_static',
    'previews.update_own',
    'previews.destroy_own',
  ],
  admin: PERMISSIONS,
};

export type SessionUser = { id: string; email: string; role: { id: string; name: string } };

export type SessionInfo =
  | { authenticated: false; setupRequired: boolean }
  | {
      authenticated: true;
      setupRequired: false;
      user?: SessionUser;
      token?: { id: string; scopes: Scope[] };
      permissions: Permission[];
    };

export type LoginResponse = { user: SessionUser; permissions: Permission[] };

export type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  userId: string | null;
  appName: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type GitHubStatus = {
  configured: boolean;
  appId: string;
  appSlug: string;
  appUrl: string | null;
  installUrl: string | null;
  webhookUrl: string;
  missing: string[];
  managedByConfig: boolean;
};

export type ManifestStart = { action: string; manifest: Record<string, unknown>; state: string };

export type ForkPolicy = 'ask' | 'auto' | 'never';
export const FORK_POLICIES: readonly ForkPolicy[] = ['ask', 'auto', 'never'];

export type SecretLevel = 'low' | 'standard' | 'high';
export type Clearance = 'none' | SecretLevel;
export const CLEARANCES: readonly Clearance[] = ['none', 'low', 'standard', 'high'];
export const SECRET_LEVELS: readonly SecretLevel[] = ['low', 'standard', 'high'];
export type SecretListing = { name: string; level: SecretLevel };

export type PrTrigger = 'workflow' | 'webhook';
export const PR_TRIGGERS: readonly PrTrigger[] = ['workflow', 'webhook'];

export type Project = {
  id: string;
  name: string;
  slug: string;
  forge: 'github' | null;
  fullName: string | null;
  installationId: string;
  prTrigger: PrTrigger;
  enabled: boolean;
  disabledReason: string | null;
  templateId: string | null;
  visibility: Visibility | null;
  ttl: string | null;
  forks: ForkPolicy;
  drafts: boolean;
  prClearance: Clearance | null;
  forkClearance: Clearance;
  createdAt: string;
  updatedAt: string;
};
export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'slug'
    | 'prTrigger'
    | 'enabled'
    | 'templateId'
    | 'visibility'
    | 'ttl'
    | 'forks'
    | 'drafts'
    | 'prClearance'
    | 'forkClearance'
  >
> & { repository?: string | null };
export type ProjectCreate = {
  name: string;
  slug?: string;
  repository?: string;
  prTrigger?: PrTrigger;
  templateId?: string | null;
};
export type InstalledRepository = { fullName: string; installationId: string; private: boolean };

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
  createdAt: string;
  updatedAt: string;
};
export type TemplatePatch = Partial<
  Pick<
    Template,
    'name' | 'description' | 'visibility' | 'ttl' | 'idleAfter' | 'clearance' | 'hostId'
  >
>;
export type TemplateCreate = TemplatePatch & { id: string; name: string };

export type Trigger = 'pr' | 'api' | 'manual';
export const TRIGGERS: readonly Trigger[] = ['pr', 'api', 'manual'];

export type SettingView = {
  key: string;
  value: unknown;
  source: 'config' | 'database' | 'default';
  managedByConfig: boolean;
  secret: boolean;
  set: boolean;
};

export type SurfaceState = { enabled: boolean; managedByConfig: boolean };
export type Surfaces = {
  ui: SurfaceState;
  mcp: SurfaceState & { url: string };
  adminTokenExists: boolean;
  reenableUi: string;
};
export type Capabilities = { surfaces: { ui: boolean; mcp: boolean }; mcpUrl: string };
export const DISABLE_UI_PHRASE = 'disable the UI';

export type OAuthScope = 'read' | 'deploy' | 'update' | 'artifacts';
export type ConsentRequest = {
  id: string;
  client: { id: string; name: string; host: string };
  redirectUri: string;
  redirectHost: string;
  resource: string;
  requested: OAuthScope[];
  /** What was asked for, then any narrower stand-in the person may pick instead. */
  offered: OAuthScope[];
  grantable: OAuthScope[];
  scopePermissions: Record<OAuthScope, Permission[]>;
  expiresAt: string;
};
export type OAuthGrant = {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: OAuthScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
};

export type RuntimeId = 'static' | 'node' | 'bun' | 'deno' | 'workerd' | 'python' | 'php';
export const RUNTIME_IDS: readonly RuntimeId[] = [
  'static',
  'node',
  'bun',
  'deno',
  'workerd',
  'python',
  'php',
];
export type Detected = RuntimeId | 'own';

export type Runtime = {
  id: RuntimeId;
  name: string;
  language: string;
  description: string;
  image: string;
  port: number;
  starter: Record<string, string>;
  versions: string[];
};
export type DetectionRule = { runtime: Detected; markers: string[] };
export type RuntimeList = {
  runtimes: Runtime[];
  detection: DetectionRule[];
  planFiles: string[];
  addons: AddonInfo[];
};

export type AddonId = 'postgres' | 'mysql' | 'redis';
export const ADDON_IDS: readonly AddonId[] = ['postgres', 'mysql', 'redis'];
export type AddonChoice = { id: AddonId; version: string };
export type AddonInfo = {
  id: AddonId;
  name: string;
  description: string;
  versions: string[];
  defaultVersion: string;
  env: string[];
};

export type PreviewAddon = AddonChoice & { name: string; service: string; env: string[] };
export type DataTable = { schema: string; name: string };
export type DataResult = {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  message: string | null;
  ms: number;
};
export type RedisKeys = { cursor: string; keys: string[] };
export type RedisKey = { type: string; ttl: string; value: DataResult };

export type SourceFile = { path: string; size: number; text?: string };
export type PreviewSourceFiles = {
  runtime: RuntimeId | null;
  files: SourceFile[];
  truncated: boolean;
};

export type SourcePatch = {
  files: Record<string, string | null>;
  runtime?: Detected;
  addons?: AddonId[];
};

export type RedeployPhase = 'started' | 'succeeded' | 'failed';
export type RedeployAccepted = { buildId: string };
export type RedeployDone = { buildId: string; outcome: 'succeeded' | 'failed'; error?: string };
