// Never rename an id: grants reference it.
export const PERMISSIONS = [
  {
    id: "previews.read",
    feature: "previews",
    description: "List previews and see their detail, URLs and builds",
  },
  {
    id: "previews.read_own",
    feature: "previews",
    description: "List and see previews you deployed, and their logs",
  },
  {
    id: "previews.deploy",
    feature: "previews",
    description: "Deploy any preview, including apps that run in a container",
  },
  {
    id: "previews.deploy_static",
    feature: "previews",
    description: "Deploy artifacts and static sites that gangway serves itself, with no container",
  },
  { id: "previews.destroy", feature: "previews", description: "Destroy any preview" },
  {
    id: "previews.destroy_own",
    feature: "previews",
    description: "Destroy previews you deployed",
  },
  {
    id: "previews.update",
    feature: "previews",
    description: "Change a preview's uploaded source and rebuild it at the same URL",
  },
  {
    id: "previews.update_own",
    feature: "previews",
    description: "Rebuild previews you deployed, at the same URL",
  },
  {
    id: "previews.data",
    feature: "previews",
    description: "Browse and query a preview's add-on databases (every query is audited)",
  },
  {
    id: "previews.view_private",
    feature: "previews",
    description: "Open previews whose visibility is private",
  },
  {
    id: "previews.skip_password",
    feature: "previews",
    description: "Open password-protected previews by being signed in, without the password",
  },
  {
    id: "logs.read",
    feature: "logs",
    description: "Read and follow preview build and runtime logs",
  },
  { id: "events.read", feature: "events", description: "Follow the global state stream" },
  {
    id: "hosts.read",
    feature: "hosts",
    description: "See registered Docker hosts and their state",
  },
  { id: "hosts.manage", feature: "hosts", description: "Register, edit and remove Docker hosts" },
  {
    id: "tokens.manage_own",
    feature: "tokens",
    description: "Create and revoke your own API tokens",
  },
  {
    id: "tokens.manage_all",
    feature: "tokens",
    description: "See and revoke every user's API tokens",
  },
  { id: "users.read", feature: "users", description: "See accounts and their roles" },
  {
    id: "users.manage",
    feature: "users",
    description: "Create, disable and re-role accounts; reset passwords",
  },
  {
    id: "roles.read",
    feature: "roles",
    description: "See roles and the permissions each one grants",
  },
  { id: "roles.manage", feature: "roles", description: "Change which permissions a role grants" },
  { id: "audit.read", feature: "audit", description: "Read the audit log" },
  { id: "settings.read", feature: "settings", description: "See server settings" },
  { id: "settings.write", feature: "settings", description: "Change server settings" },
  {
    id: "surfaces.manage",
    feature: "settings",
    description: "Enable and disable the UI and MCP surfaces",
  },
  { id: "github.manage", feature: "github", description: "Connect the GitHub App" },
  {
    id: "repos.manage",
    feature: "repos",
    description: "Tune a repository: its slug, template, overrides and fork policy",
  },
  {
    id: "repos.secrets",
    feature: "repos",
    description: "Set secrets, global and per repository (values are never shown)",
  },
  {
    id: "templates.manage",
    feature: "templates",
    description: "Create, edit and delete templates",
  },
  {
    id: "apps.read",
    feature: "apps",
    description: "See the system app catalog and what is installed",
  },
  { id: "apps.install", feature: "apps", description: "Install and uninstall system apps" },
  { id: "jobs.claim", feature: "jobs", description: "Create and claim ephemeral jobs" },
] as const satisfies readonly { id: string; feature: string; description: string }[];

export type Permission = (typeof PERMISSIONS)[number]["id"];

export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS.map((p) => p.id);

const KNOWN: ReadonlySet<string> = new Set(ALL_PERMISSIONS);
export const isPermission = (s: string): s is Permission => KNOWN.has(s);

export const SCOPES = ["read", "deploy", "update", "artifacts", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

const READ: readonly Permission[] = ["previews.read", "logs.read", "events.read", "hosts.read"];

export const SCOPE_PERMISSIONS: Record<Scope, readonly Permission[]> = {
  read: READ,
  deploy: [...READ, "previews.deploy", "previews.destroy_own", "previews.update_own"],
  update: ["previews.update"],
  // For an agent you do not trust with a container: it sees and touches only what it deployed.
  artifacts: [
    "previews.read_own",
    "previews.deploy_static",
    "previews.update_own",
    "previews.destroy_own",
  ],
  admin: ALL_PERMISSIONS,
};

export type BuiltinRole = "admin" | "member" | "viewer";
export const ADMIN_ROLE_ID: BuiltinRole = "admin";

export const DEFAULT_ROLE_PERMISSIONS: Record<
  Exclude<BuiltinRole, "admin">,
  readonly Permission[]
> = {
  member: [
    ...READ,
    "previews.read_own",
    "previews.deploy",
    "previews.deploy_static",
    "previews.destroy",
    "previews.destroy_own",
    "previews.update_own",
    "previews.view_private",
    "previews.skip_password",
    "tokens.manage_own",
  ],
  viewer: [...READ, "previews.read_own", "previews.view_private", "previews.skip_password"],
};
