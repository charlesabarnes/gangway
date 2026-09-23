import { TRIGGERS, type Trigger } from "@gangway/shared/domain";
import { publicOriginFor } from "@gangway/shared/url";
import type { Hono } from "hono";
import type { AppEnv } from "../app/env.ts";
import type { McpSurface } from "../app/mcp-surface.ts";
import type { AuthDeps } from "../app/middleware/auth.ts";
import { addonRoutes } from "../app/routes/addons.ts";
import { auditRoutes } from "../app/routes/audit.ts";
import { authRoutes } from "../app/routes/auth.ts";
import { eventRoutes } from "../app/routes/events.ts";
import { githubRoutes } from "../app/routes/github.ts";
import { hostRoutes } from "../app/routes/hosts.ts";
import { oauthRoutes } from "../app/routes/oauth.ts";
import { previewRoutes } from "../app/routes/previews.ts";
import { projectRoutes } from "../app/routes/projects.ts";
import { roleRoutes } from "../app/routes/roles.ts";
import { runtimeRoutes, schemaRoutes } from "../app/routes/runtimes.ts";
import { secretRoutes } from "../app/routes/secrets.ts";
import { settingsRoutes } from "../app/routes/settings.ts";
import { surfaceRoutes } from "../app/routes/surfaces.ts";
import { templateRoutes } from "../app/routes/templates.ts";
import { tokenRoutes } from "../app/routes/tokens.ts";
import { userRoutes } from "../app/routes/users.ts";
import type { Passwords } from "../auth/password.ts";
import type { GitHubApp } from "../forge/github/app.ts";
import { ManifestStates } from "../forge/github/manifest.ts";
import { safePath, type PreviewGate } from "../net/gate.ts";
import type { PreviewContext } from "../previews/context.ts";
import { DataBrowser } from "../previews/data/service.ts";
import { urlsFor } from "../previews/deploy.ts";
import type { IdempotentDeploys } from "../previews/idempotent.ts";
import { previewAccess } from "../previews/password.ts";
import type { Pulls } from "../projects/pulls.ts";
import type { Secrets } from "../secrets/secrets.ts";
import type { Core } from "./core.ts";
import type { Identity } from "./identity.ts";

export type ApiRouteDeps = Pick<
  Core,
  "repos" | "bus" | "audit" | "settings" | "origin" | "baseDomain"
> & {
  ctx: PreviewContext;
  deploys: IdempotentDeploys;
  secrets: Secrets;
  previewPasswords: Passwords;
  triggerDefault: (t: Trigger) => string;
  identity: Identity;
  githubApp: GitHubApp;
  pulls: Pulls;
  mcp: McpSurface;
  mcpOn: () => boolean;
  signal: AbortSignal;
};

export function v1Routes(api: Hono<AppEnv>, d: ApiRouteDeps): void {
  const { ctx, repos, audit, settings, identity } = d;
  const { oauth } = identity;
  const apiOrigin = () => d.origin("api");
  hostRoutes(api, repos.hosts);
  eventRoutes(api, d.bus, { signal: d.signal });
  previewRoutes(api, ctx, d.deploys, { signal: d.signal });
  runtimeRoutes(api);
  addonRoutes(api, new DataBrowser(ctx));
  auditRoutes(api, repos.audit);
  tokenRoutes(api, identity.tokens);
  userRoutes(api, identity.accounts);
  roleRoutes(api, identity.roles);
  settingsRoutes(api, settings, audit, repos.templates, (plain) => d.previewPasswords.hash(plain));
  oauthRoutes(api, { oauth, enabled: d.mcpOn });
  surfaceRoutes(api, {
    settings,
    audit,
    apiOrigin,
    hasActiveAdmin: () => repos.tokens.hasActiveAdmin(Date.now()),
    mcpOrigin: () => d.origin("mcp"),
    onMcpDisabled: () => d.mcp.dropAll(),
  });
  projectRoutes(api, {
    projects: repos.projects,
    audit,
    secrets: d.secrets,
    templates: repos.templates,
    pulls: d.pulls,
    apiOrigin,
    wire: (p) => ({ ...p, access: previewAccess(ctx.passwords, p), urls: urlsFor(ctx, p.id) }),
  });
  templateRoutes(api, {
    templates: repos.templates,
    hosts: repos.hosts,
    audit,
    namedByTrigger: (id) => TRIGGERS.filter((t) => d.triggerDefault(t) === id),
  });
  secretRoutes(api, d.secrets);
  githubRoutes(api, {
    app: d.githubApp,
    settings,
    states: new ManifestStates(),
    audit,
    baseDomain: d.baseDomain,
    originFor: d.origin,
  });
}

export type PublicRouteDeps = {
  ctx: PreviewContext;
  auth: AuthDeps;
  identity: Identity;
  gate: PreviewGate;
};

export function publicRoutes(pub: Hono<AppEnv>, { ctx, auth, identity, gate }: PublicRouteDeps) {
  const { table } = ctx;
  authRoutes(pub, {
    auth,
    accounts: identity.accounts,
    bootstrap: identity.bootstrap,
    roles: identity.roles,
    sessionMaxAgeSec: Math.floor(identity.sessions.timings.absoluteMs / 1000),
    gate: {
      lookup: (host) => table.lookup(host),
      issueTicket: (e, o) => gate.issueTicket(e, o),
      gateable: (host) => {
        const e = table.lookup(host);
        return e ? gate.gateable(e) : { private: false, passwordSkippable: false };
      },
      originFor: (host) => publicOriginFor(host, ctx.origin),
      safePath,
    },
  });
  schemaRoutes(pub);
}
