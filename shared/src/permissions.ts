/**
 * The permission catalogue. A permission is the unit of enforcement: routes and services
 * ask "may this actor do X", never "is this actor an admin". WHICH role holds WHICH
 * permission is data (the `role_permissions` table) and the operator's to change; WHAT
 * permissions exist is code, because a permission nothing checks is a lie.
 *
 * Every feature of all six phases (§14) is listed now, so the matrix an operator edits is
 * complete from the start and a later phase adds a check, not a schema change. The
 * `permissions` table is seeded from this list and re-synced at boot.
 *
 * Ids are `<feature>.<verb>`. Never rename one: grants reference it.
 */
export const PERMISSIONS = [
  { id: "previews.read", feature: "previews", description: "List previews and see their detail, URLs and builds" },
  { id: "previews.deploy", feature: "previews", description: "Deploy a new preview" },
  { id: "previews.destroy", feature: "previews", description: "Destroy any preview" },
  { id: "previews.update", feature: "previews", description: "Change a preview's uploaded source and rebuild it at the same URL" },
  { id: "previews.update_own", feature: "previews", description: "Rebuild previews you deployed, at the same URL" },
  { id: "previews.data", feature: "previews", description: "Browse and query a preview's add-on databases (every query is audited)" },
  { id: "previews.view_private", feature: "previews", description: "Open previews whose visibility is private" },
  { id: "logs.read", feature: "logs", description: "Read and follow preview build and runtime logs" },
  { id: "events.read", feature: "events", description: "Follow the global state stream" },
  { id: "hosts.read", feature: "hosts", description: "See registered Docker hosts and their state" },
  { id: "hosts.manage", feature: "hosts", description: "Register, edit and remove Docker hosts" },
  { id: "tokens.manage_own", feature: "tokens", description: "Create and revoke your own API tokens" },
  { id: "tokens.manage_all", feature: "tokens", description: "See and revoke every user's API tokens" },
  { id: "users.read", feature: "users", description: "See accounts and their roles" },
  { id: "users.manage", feature: "users", description: "Create, disable and re-role accounts; reset passwords" },
  { id: "roles.read", feature: "roles", description: "See roles and the permissions each one grants" },
  { id: "roles.manage", feature: "roles", description: "Change which permissions a role grants" },
  { id: "audit.read", feature: "audit", description: "Read the audit log" },
  { id: "settings.read", feature: "settings", description: "See server settings" },
  { id: "settings.write", feature: "settings", description: "Change server settings" },
  { id: "surfaces.manage", feature: "settings", description: "Enable and disable the UI and MCP surfaces" },
  { id: "github.manage", feature: "github", description: "Connect the GitHub App" },
  { id: "repos.manage", feature: "repos", description: "Tune a repository: its slug, template, overrides and fork policy" },
  { id: "repos.secrets", feature: "repos", description: "Set secrets, global and per repository (values are never shown)" },
  { id: "templates.manage", feature: "templates", description: "Create, edit and delete templates" },
  { id: "apps.read", feature: "apps", description: "See the system app catalog and what is installed" },
  { id: "apps.install", feature: "apps", description: "Install and uninstall system apps" },
  { id: "jobs.claim", feature: "jobs", description: "Create and claim ephemeral jobs" },
] as const satisfies readonly { id: string; feature: string; description: string }[];

export type Permission = (typeof PERMISSIONS)[number]["id"];

export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS.map((p) => p.id);

const KNOWN: ReadonlySet<string> = new Set(ALL_PERMISSIONS);
export const isPermission = (s: string): s is Permission => KNOWN.has(s);

/**
 * §8.2 token scopes. A scope is a fixed BUNDLE of permissions, so a token stays a
 * few-word thing to reason about while enforcement stays fine-grained. A user-owned
 * token never exceeds its owner: the effective set is the bundle INTERSECTED with the
 * owner's role, at verify time.
 *
 * ADR-0021: `deploy` carries `previews.update_own` (an agent iterates on what it made);
 * `update` is `previews.update` alone -- rebuild ANY preview -- added to the others, never
 * useful by itself.
 */
export const SCOPES = ["read", "deploy", "update", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

const READ: readonly Permission[] = ["previews.read", "logs.read", "events.read", "hosts.read"];

export const SCOPE_PERMISSIONS: Record<Scope, readonly Permission[]> = {
  read: READ,
  deploy: [...READ, "previews.deploy", "previews.destroy", "previews.update_own"],
  update: ["previews.update"],
  admin: ALL_PERMISSIONS,
};

/** The three roles every install starts with. `admin` holds everything, always, in code. */
export const BUILTIN_ROLES = ["admin", "member", "viewer"] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];
export const ADMIN_ROLE_ID: BuiltinRole = "admin";

/**
 * What `member` and `viewer` are SEEDED with (§8.1). Defaults only -- the matrix is the
 * operator's. The migrations insert exactly this (0003, and 0010 for `update_own`), and a
 * test holds the two together.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Exclude<BuiltinRole, "admin">, readonly Permission[]> = {
  member: [...READ, "previews.deploy", "previews.destroy", "previews.update_own", "previews.view_private", "tokens.manage_own"],
  viewer: [...READ, "previews.view_private"],
};
