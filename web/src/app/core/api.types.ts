/**
 * The wire shapes of `/v1`, as the browser sees them. Hand-written on purpose: the server's
 * domain types carry `Date`s and Bun-only import conventions, and what crosses the network
 * is JSON -- every timestamp here is an ISO string.
 *
 * Kept honest by `src/testing/fixtures/*.json`: the SERVER's test suite asserts its real
 * output matches those files, and this project's specs assert the files satisfy these
 * types. Change either side alone and a test fails.
 */

export type PreviewState = 'building' | 'starting' | 'awake' | 'asleep' | 'failed' | 'destroying' | 'destroyed';
export const PREVIEW_STATES: readonly PreviewState[] = ['building', 'starting', 'awake', 'asleep', 'failed', 'destroying', 'destroyed'];

export type Visibility = 'public' | 'unlisted' | 'private';
export const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private'];

export type PreviewSource =
  | { kind: 'pr'; repo: string; number: number; sha: string }
  | { kind: 'manual'; userId: string }
  | { kind: 'agent'; tokenId: string; idempotencyKey: string }
  | { kind: 'image'; image: string }
  | { kind: 'tarball'; uploadId: string }
  | { kind: 'git'; repo: string; ref: string };
export type SourceKind = PreviewSource['kind'];

export type PreviewUrl = { service: string; url: string; primary: boolean };

export type Preview = {
  id: string;
  project: string;
  hostId: string;
  kind: 'preview' | 'job';
  state: PreviewState;
  source: PreviewSource;
  visibility: Visibility;
  ttlExpiresAt: string | null;
  /** Idle-sleep after this many ms without a request, pinned at deploy; 0: never; null: before templates. */
  idleAfterMs: number | null;
  /** The clearance this preview was deployed with. */
  secretLevel: Clearance | null;
  /** The template it was deployed with (ADR-0013); null on previews from before templates. */
  templateId: string | null;
  lastSeenAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  destroyedAt: string | null;
  urls: PreviewUrl[];
};

/** `seq` is the event cursor to follow `/v1/events` from -- read by the server BEFORE the list. */
export type PreviewList = { seq: number; previews: Preview[] };

export type PreviewEvent = { seq: number; type: string; at: string; state?: PreviewState; from?: PreviewState; error?: string };

export type Build = {
  id: string; previewId: string; service: string | null;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string; finishedAt: string | null; exitCode: number | null;
};

export type LogStream = 'system' | 'build' | 'seed' | 'stdout' | 'stderr';
export const LOG_STREAMS: readonly LogStream[] = ['system', 'build', 'seed', 'stdout', 'stderr'];
export type LogLine = { n: number; at: string; stream: LogStream; line: string };

/** What `/v1/events` carries. `reset` is synthetic: drop local state, refetch, keep following. */
export type StreamEvent =
  | { type: 'preview.created'; previewId: string; at: string }
  | { type: 'preview.adopted'; previewId: string; at: string }
  | { type: 'preview.state'; previewId: string; at: string; state: PreviewState; from: PreviewState; error?: string }
  | { type: 'reset'; at: string };
export const STREAM_EVENT_TYPES = ['preview.created', 'preview.adopted', 'preview.state', 'reset'] as const;

/**
 * Permissions are what the UI gates on -- never a role name, because which role holds what
 * is the operator's to change. Mirrors `shared/src/permissions.ts`; pinned by
 * `fixtures/permissions.json`.
 */
export const PERMISSIONS = [
  'previews.read', 'previews.deploy', 'previews.destroy', 'previews.view_private',
  'logs.read', 'events.read', 'hosts.read', 'hosts.manage',
  'tokens.manage_own', 'tokens.manage_all', 'users.read', 'users.manage', 'roles.read', 'roles.manage',
  'audit.read', 'settings.read', 'settings.write', 'surfaces.manage', 'github.manage', 'repos.manage', 'repos.secrets', 'templates.manage',
  'apps.read', 'apps.install', 'jobs.claim',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type Scope = 'read' | 'deploy' | 'admin';
export const SCOPES: readonly Scope[] = ['read', 'deploy', 'admin'];

const READ_BUNDLE: readonly Permission[] = ['previews.read', 'logs.read', 'events.read', 'hosts.read'];
/**
 * What each token scope grants. The server refuses to mint a scope the role does not fully
 * cover (a do-nothing "admin" token would turn real the day its owner was promoted), so
 * the form greys those out -- from this table, pinned by `contract.json`.
 */
export const SCOPE_PERMISSIONS: Record<Scope, readonly Permission[]> = {
  read: READ_BUNDLE,
  deploy: [...READ_BUNDLE, 'previews.deploy', 'previews.destroy'],
  admin: PERMISSIONS,
};

export type SessionUser = { id: string; email: string; role: { id: string; name: string } };

/** `GET /v1/auth/session` is always 200; this is its whole range. */
export type SessionInfo =
  | { authenticated: false; setupRequired: boolean }
  | { authenticated: true; setupRequired: false; user?: SessionUser; token?: { id: string; scopes: Scope[] }; permissions: Permission[] };

export type LoginResponse = { user: SessionUser; permissions: Permission[] };

export type ApiToken = {
  id: string; name: string; prefix: string; scopes: Scope[]; userId: string | null; appName: string | null;
  expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null; createdAt: string;
};

/* ---- Phase 3: GitHub and repositories (ADR-0011) */

/** `GET /v1/github`: connected or not, and where to go next. Never a secret. */
export type GitHubStatus = {
  configured: boolean; appId: string; appSlug: string; appUrl: string | null; installUrl: string | null;
  webhookUrl: string; missing: string[]; managedByConfig: boolean;
};

/** `GET /v1/github/manifest`: what the browser posts to GitHub as a form, and the state GitHub echoes back. */
export type ManifestStart = { action: string; manifest: Record<string, unknown>; state: string };

export type ForkPolicy = 'ask' | 'auto' | 'never';
export const FORK_POLICIES: readonly ForkPolicy[] = ['ask', 'auto', 'never'];

/** Secrets have a level; a preview has a clearance and gets every secret at or below it. */
export type SecretLevel = 'low' | 'standard' | 'high';
export type Clearance = 'none' | SecretLevel;
export const CLEARANCES: readonly Clearance[] = ['none', 'low', 'standard', 'high'];
export const SECRET_LEVELS: readonly SecretLevel[] = ['low', 'standard', 'high'];
export type SecretListing = { name: string; level: SecretLevel };

/** `templateId` names the template its previews follow; `visibility`, `ttl` and `prClearance` override it (null: the template's). */
export type Repo = {
  id: string; forge: 'github'; fullName: string; installationId: string; slug: string;
  enabled: boolean; disabledReason: string | null; templateId: string | null; visibility: Visibility | null; ttl: string | null;
  forks: ForkPolicy; drafts: boolean; prClearance: Clearance | null; forkClearance: Clearance; createdAt: string; updatedAt: string;
};
export type RepoPatch = Partial<Pick<Repo, 'slug' | 'enabled' | 'templateId' | 'visibility' | 'ttl' | 'forks' | 'drafts' | 'prClearance' | 'forkClearance'>>;

/* ---- Templates (ADR-0013) */

/** A named preview policy. `default` is built in. */
export type Template = {
  id: string; name: string; description: string; builtin: boolean;
  visibility: Visibility; ttl: string | null; idleAfter: string; clearance: Clearance; hostId: string | null;
  createdAt: string; updatedAt: string;
};
export type TemplatePatch = Partial<Pick<Template, 'name' | 'description' | 'visibility' | 'ttl' | 'idleAfter' | 'clearance' | 'hostId'>>;
export type TemplateCreate = TemplatePatch & { id: string; name: string };

/** The deploy triggers a default template is set for: `templates.default.<trigger>` in settings. */
export type Trigger = 'pr' | 'api' | 'manual';
export const TRIGGERS: readonly Trigger[] = ['pr', 'api', 'manual'];

/** One row of `GET /v1/settings`. A secret's value is never sent, only whether one is set. */
export type SettingView = { key: string; value: unknown; source: 'config' | 'database' | 'default'; managedByConfig: boolean; secret: boolean; set: boolean };
