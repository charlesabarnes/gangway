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
  /** `runtime` absent: the upload brought its own compose file or Dockerfile (ADR-0015). */
  | { kind: 'tarball'; uploadId: string; runtime?: RuntimeId; addons?: AddonChoice[] }
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
  /** The project it belongs to (ADR-0014); null for one deployed outside any. */
  projectId: string | null;
  lastSeenAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  destroyedAt: string | null;
  urls: PreviewUrl[];
};

/** `seq` is the event cursor to follow `/v1/events` from -- read by the server BEFORE the list. */
export type PreviewList = { seq: number; previews: Preview[] };

export type PreviewEvent = { seq: number; type: string; at: string; state?: PreviewState; from?: PreviewState; error?: string; phase?: RedeployPhase; buildId?: string; by?: string };

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
  | { type: 'preview.redeploy'; previewId: string; at: string; phase: RedeployPhase; buildId: string; by: string; error?: string }
  | { type: 'reset'; at: string };
export const STREAM_EVENT_TYPES = ['preview.created', 'preview.adopted', 'preview.state', 'preview.redeploy', 'reset'] as const;

/**
 * Permissions are what the UI gates on -- never a role name, because which role holds what
 * is the operator's to change. Mirrors `shared/src/permissions.ts`; pinned by
 * `fixtures/permissions.json`.
 */
export const PERMISSIONS = [
  'previews.read', 'previews.deploy', 'previews.destroy', 'previews.update', 'previews.data', 'previews.view_private',
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
/** How a project's pull requests arrive (ADR-0014): its own GitHub Actions workflow, or the GitHub App's webhook. */
export type PrTrigger = 'workflow' | 'webhook';
export const PR_TRIGGERS: readonly PrTrigger[] = ['workflow', 'webhook'];

/**
 * The thing you preview (ADR-0014). `forge`/`fullName` are both null for a project with
 * no repository. `templateId` names its template; `visibility`, `ttl` and `prClearance`
 * override it (null: the template's).
 */
export type Project = {
  id: string; name: string; slug: string; forge: 'github' | null; fullName: string | null; installationId: string; prTrigger: PrTrigger;
  enabled: boolean; disabledReason: string | null; templateId: string | null; visibility: Visibility | null; ttl: string | null;
  forks: ForkPolicy; drafts: boolean; prClearance: Clearance | null; forkClearance: Clearance; createdAt: string; updatedAt: string;
};
export type ProjectPatch = Partial<Pick<Project, 'name' | 'slug' | 'prTrigger' | 'enabled' | 'templateId' | 'visibility' | 'ttl' | 'forks' | 'drafts' | 'prClearance' | 'forkClearance'>> & { repository?: string | null };
export type ProjectCreate = { name: string; slug?: string; repository?: string; prTrigger?: PrTrigger; templateId?: string | null };
/** `GET /v1/github/repositories`: where the App is installed. */
export type InstalledRepository = { fullName: string; installationId: string; private: boolean };

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

/* ---- Surfaces (§10.5) */

export type SurfaceState = { enabled: boolean; managedByConfig: boolean };
/** `GET|PUT /v1/surfaces`. `reenableUi` is the exact curl the disable dialog shows. */
export type Surfaces = { ui: SurfaceState; mcp: SurfaceState & { url: string }; adminTokenExists: boolean; reenableUi: string };
/** `GET /v1/capabilities`: what is live, for anyone who can see previews. */
export type Capabilities = { surfaces: { ui: boolean; mcp: boolean }; mcpUrl: string };
/** The server checks it: turning the UI off without it is a 422. */
export const DISABLE_UI_PHRASE = 'disable the UI';

/* ---- Runtimes and editable previews (ADR-0015) */

export type RuntimeId = 'static' | 'node' | 'bun' | 'deno' | 'workerd' | 'python' | 'php';
export const RUNTIME_IDS: readonly RuntimeId[] = ['static', 'node', 'bun', 'deno', 'workerd', 'python', 'php'];
/** `own`: the upload brings its own compose file or Dockerfile. */
export type Detected = RuntimeId | 'own';

/** One entry of `GET /v1/runtimes`: a way to build a folder with no Dockerfile. */
export type Runtime = {
  id: RuntimeId; name: string; language: string; description: string; image: string; port: number;
  /** What a new preview of this runtime starts with: path -> text. */
  starter: Record<string, string>;
  /** The versions `gangway.yml` may ask for (ADR-0016). */
  versions: string[];
};
/** Root-level marker files; the first rule with any marker present wins, else `static`. */
export type DetectionRule = { runtime: Detected; markers: string[] };
/** `planFiles`: whose CONTENTS `POST /v1/runtimes/plan` wants (root and one level down); the rest are only named. */
export type RuntimeList = { runtimes: Runtime[]; detection: DetectionRule[]; planFiles: string[]; addons: AddonInfo[] };

/* ---- Add-ons (ADR-0017): throwaway databases beside a preview */

export type AddonId = 'postgres' | 'mysql' | 'redis';
export const ADDON_IDS: readonly AddonId[] = ['postgres', 'mysql', 'redis'];
/** What a preview runs, at the major it was created with. */
export type AddonChoice = { id: AddonId; version: string };
/** One entry of `GET /v1/runtimes` `addons`. `env`: the variables the app receives. */
export type AddonInfo = { id: AddonId; name: string; description: string; versions: string[]; defaultVersion: string; env: string[] };

/* ---- The data browser (ADR-0018): needs `previews.data` */

/** `GET /v1/previews/:id/addons` (previews.read). */
export type PreviewAddon = AddonChoice & { name: string; service: string; env: string[] };
export type DataTable = { schema: string; name: string };
/** A query's answer. A cell is null for SQL NULL. `message`: what the database said on stderr (notices). */
export type DataResult = { columns: string[]; rows: (string | null)[][]; truncated: boolean; message: string | null; ms: number };
export type RedisKeys = { cursor: string; keys: string[] };
export type RedisKey = { type: string; ttl: string; value: DataResult };

/* ---- The app plan (ADR-0016): what the server will do with an upload, and why */

/** A shell command, or an argv run as it is. */
export type Command = string | string[];
export type PlanReason = { level: 'info' | 'warn' | 'error'; found: string; then: string };
/** A gangway.yml problem at a dotted key path ('' for the file as a whole). */
export type PlanIssue = { path: string; message: string };
export type AppPlan = {
  kind: 'own' | 'runtime'; runtime: RuntimeId | null; version: string | null; image: string | null;
  /** The app's directory within the upload; '' is its root. */
  root: string;
  install: Command | null; build: Command | null; start: Command | null; release: Command | null;
  serve: { kind: 'server' } | { kind: 'static'; output: string | null | false; fallback: 'spa' | '404' | 'listing' };
  docroot: string; entry: string | null; port: number | null; health: string | null;
  env: Record<string, string>;
  stack: { ttl?: string; visibility?: Visibility; idle?: string; seed?: string };
  configFile: string | null;
  addons: AddonChoice[];
  /** Add-ons the dependencies point at; the New screen pre-ticks them. */
  suggested: { id: AddonId; because: string }[];
  sqlSeed: string | null;
  reasons: PlanReason[];
  issues: PlanIssue[];
};
/** `POST /v1/runtimes/plan`. */
export type PlanRequest = { paths: string[]; files: Record<string, string>; runtime?: Detected | 'auto'; addons?: AddonId[] };

/** `GET /v1/previews/:id/source`. `text` is absent on a binary or too-large file: listed, not editable. */
export type SourceFile = { path: string; size: number; text?: string };
export type PreviewSourceFiles = { runtime: RuntimeId | null; files: SourceFile[]; truncated: boolean };

/** `PATCH /v1/previews/:id/source`: text sets a file, null deletes it. */
export type SourcePatch = { files: Record<string, string | null>; runtime?: Detected; addons?: AddonId[] };

export type RedeployPhase = 'started' | 'succeeded' | 'failed';
/** 202 from PATCH/PUT `…/source` (with `preview`). */
export type RedeployAccepted = { buildId: string };
/** `?wait=true` (with `preview`). */
export type RedeployDone = { buildId: string; outcome: 'succeeded' | 'failed'; error?: string };
