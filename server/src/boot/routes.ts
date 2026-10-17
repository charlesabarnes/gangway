import { TRIGGERS, type Trigger } from "@gangway/shared/domain";
import { isLocalDomain } from "@gangway/shared/hostname";
import { publicOriginFor } from "@gangway/shared/url";
import type { Hono } from "hono";
import type { AppEnv } from "../app/env.ts";
import type { McpSurface } from "../app/mcp-surface.ts";
import type { AuthDeps } from "../app/middleware/auth.ts";
import { addonRoutes } from "../app/routes/addons.ts";
import { artifactRoutes } from "../app/routes/artifacts.ts";
import { auditRoutes } from "../app/routes/audit.ts";
import { operatorRoutes } from "../app/routes/operator.ts";
import { authRoutes } from "../app/routes/auth.ts";
import { domainRoutes } from "../app/routes/domains.ts";
import { eventRoutes } from "../app/routes/events.ts";
import { githubRoutes } from "../app/routes/github.ts";
import { hostRoutes } from "../app/routes/hosts.ts";
import { oauthRoutes } from "../app/routes/oauth.ts";
import { previewRoutes } from "../app/routes/previews.ts";
import { projectRoutes } from "../app/routes/projects.ts";
import { roleRoutes } from "../app/routes/roles.ts";
import { runtimeRoutes, schemaRoutes } from "../app/routes/runtimes.ts";
import { previewSecretRoutes, secretRoutes } from "../app/routes/secrets.ts";
import { mailSettingsRoutes, settingsRoutes } from "../app/routes/settings.ts";
import { surfaceRoutes } from "../app/routes/surfaces.ts";
import { templateRoutes } from "../app/routes/templates.ts";
import { tokenRoutes } from "../app/routes/tokens.ts";
import { updateRoutes } from "../app/routes/updates.ts";
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
import type { Branches } from "../projects/branches.ts";
import type { Pulls } from "../projects/pulls.ts";
import type { Secrets } from "../secrets/secrets.ts";
import type { Core } from "./core.ts";
import { claimDeps } from "./domains.ts";
import { claimDomain } from "../domains/claims.ts";
import { relabelPreview } from "../previews/relabel.ts";
import type { DeployHostDeps } from "../projects/deploy-host.ts";
import type { Identity } from "./identity.ts";
import { acrossOrgs } from "../tenancy/scope.ts";

export type ApiRouteDeps = Pick<
  Core,
  | "db"
  | "repos"
  | "bus"
  | "audit"
  | "settings"
  | "origin"
  | "baseDomain"
  | "updates"
  | "domains"
  | "table"
> & {
  ctx: PreviewContext;
  deploys: IdempotentDeploys;
  secrets: Secrets;
  previewPasswords: Passwords;
  triggerDefault: (t: Trigger) => string;
  identity: Identity;
  githubApp: GitHubApp;
  pulls: Pulls;
  branches: Branches;
  mcp: McpSurface;
  mcpOn: () => boolean;
  signal: AbortSignal;
};

function deployHostDeps(d: ApiRouteDeps): DeployHostDeps {
  const { ctx, repos } = d;
  return {
    domainOf: (project) => ctx.domains?.resolve({ project }) ?? ctx.previewDomain(),
    preview: (id) => ctx.previews.get(id),
    relabel: (id, label) => relabelPreview(ctx, id, label),
    holds: (project, name) => repos.domains.byName(name)?.projectId === project.id,
    claim: (actor, project, name) =>
      claimDomain(claimDeps(d), actor, { kind: "project", project }, { name, kind: "exact" }),
  };
}

export function v1Routes(api: Hono<AppEnv>, d: ApiRouteDeps): void {
  const { ctx, repos, audit, settings, identity } = d;
  const apiOrigin = () => d.origin("api");
  hostRoutes(api, repos.hosts);
  eventRoutes(
    api,
    d.bus,
    { provenanceOf: (id) => ctx.previews.provenanceOf(id) },
    { signal: d.signal },
  );
  previewRoutes(api, ctx, d.deploys, { signal: d.signal });
  runtimeRoutes(api);
  addonRoutes(api, new DataBrowser(ctx));
  auditRoutes(api, repos.audit);
  tokenRoutes(api, identity.tokens);
  userRoutes(api, identity.accounts, identity.links, {
    sso: identity.sso,
    passwords: identity.passwords,
  });
  roleRoutes(api, identity.roles);
  operatorRoutes(api, {
    db: d.db,
    orgs: repos.orgs,
    roles: repos.roles,
    templates: repos.templates,
    permissions: identity.roles,
    audit,
  });
  serverSettingRoutes(api, d);
  projectRoutes(api, {
    projects: repos.projects,
    audit,
    secrets: d.secrets,
    previews: ctx.previews,
    templates: repos.templates,
    pulls: d.pulls,
    branches: d.branches,
    deployHost: deployHostDeps(d),
    apiOrigin,
    domains: ctx.domains,
    wire: (p) => ({ ...p, access: previewAccess(ctx.passwords, p), urls: urlsFor(ctx, p.id) }),
  });
  templateRoutes(api, {
    templates: repos.templates,
    hosts: repos.hosts,
    audit,
    namedByTrigger: (id) => TRIGGERS.filter((t) => d.triggerDefault(t) === id),
  });
  if (ctx.artifacts) {
    artifactRoutes(api, {
      library: ctx.artifacts,
      themes: repos.artifactThemes,
      templates: repos.artifactTemplates,
      settings,
      audit,
      deploys: d.deploys,
      wire: (p) => ({ ...p, access: previewAccess(ctx.passwords, p), urls: urlsFor(ctx, p.id) }),
      ctx,
    });
  }
  domainRoutes(api, { ...claimDeps(d), projects: repos.projects });
  secretRoutes(api, { secrets: d.secrets, previews: ctx.previews });
  previewSecretRoutes(api, {
    secrets: d.secrets,
    previews: ctx.previews,
    projects: repos.projects,
    ctx,
  });
  githubRoutes(api, {
    app: d.githubApp,
    settings,
    states: new ManifestStates(),
    audit,
    baseDomain: d.baseDomain,
    originFor: d.origin,
  });
}

function serverSettingRoutes(api: Hono<AppEnv>, d: ApiRouteDeps): void {
  const { ctx, repos, audit, settings, identity } = d;
  const hash = (plain: string) => d.previewPasswords.hash(plain);
  settingsRoutes(api, settings, audit, {
    templates: repos.templates,
    hashPassword: hash,
    domains: d.domains,
    buildSlots: ctx.buildSlots,
  });
  mailSettingsRoutes(api, audit, identity.mailer);
  updateRoutes(api, d.updates);
  oauthRoutes(api, { oauth: identity.oauth, enabled: d.mcpOn });
  surfaceRoutes(api, {
    settings,
    audit,
    apiOrigin: () => d.origin("api"),
    hasActiveAdmin: () => repos.tokens.hasActiveAdmin(Date.now()),
    mcpOrigin: () => d.origin("mcp"),
    onMcpDisabled: () => {
      d.mcp.dropAll();
    },
    previewDomains: () => d.domains.availableTo(null),
    share: () => shareCapability(ctx, d.domains.control()),
  });
}

function shareCapability(ctx: PreviewContext, control: string) {
  return { available: ctx.shares?.available() ?? false, local: isLocalDomain(control) };
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
    links: identity.links,
    roles: identity.roles,
    sessionMaxAgeSec: Math.floor(identity.sessions.timings.absoluteMs / 1000),
    sso: identity.sso,
    passwords: identity.passwords,
    gate: {
      lookup: (host) => table.lookup(host),
      orgOf: (previewId) => acrossOrgs(() => ctx.previews.get(previewId))?.orgId,
      issueTicket: (e, o) => gate.issueTicket(e, o),
      gateable: (host) => {
        const e = table.lookup(host);
        return e ? gate.gateable(e) : { private: false, passwordSkippable: false };
      },
      // A share link is Cloudflare's https on 443, whatever gangway's own public port is.
      originFor: (host) =>
        ctx.shares?.isShareHost(host) ? `https://${host}` : publicOriginFor(host, ctx.origin),
      safePath,
    },
  });
  schemaRoutes(pub);
}
