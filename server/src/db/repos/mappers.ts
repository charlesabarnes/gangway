import { DEFAULT_ICON_COLOR, type PreviewIcon } from "@gangway/shared/preview-icon";
import type {
  ApiToken,
  AuditActorType,
  AuditEntry,
  Certificate,
  Domain,
  Clearance,
  ForgeId,
  ForkPolicy,
  GangwayEvent,
  Host,
  HostCapability,
  Preview,
  PreviewSource,
  PrTrigger,
  Project,
  Role,
  Route,
  Session,
  Template,
  Visibility,
} from "@gangway/shared/domain";
import type { Scope, SecretTargets } from "@gangway/shared/permissions";
import { HOME_ORG_ID } from "./orgs.ts";

const toDate = (n: number | null | undefined): Date | null =>
  n === null || n === undefined ? null : new Date(n);
export const fromDate = (d: Date | null | undefined): number | null =>
  d === null || d === undefined ? null : d.getTime();
export const bool = (n: number): boolean => n === 1;
export const num = (b: boolean): number => (b ? 1 : 0);

export type HostRow = {
  id: string;
  name: string;
  docker_host: string;
  expect_name: string | null;
  capabilities: string;
  publish_bind: string;
  upstream_dial: string;
  upstream_address: string;
  upstream_proxy: string | null;
  port_range_start: number;
  port_range_end: number;
  state: string;
  last_error: string | null;
  last_seen_at: number | null;
  created_at: number;
};

export function rowToHost(r: HostRow): Host {
  return {
    id: r.id,
    name: r.name,
    dockerHost: r.docker_host,
    expectName: r.expect_name,
    capabilities: JSON.parse(r.capabilities) as HostCapability[],
    publishBind: r.publish_bind,
    upstream: {
      dial: r.upstream_dial as Host["upstream"]["dial"],
      address: r.upstream_address,
      proxy: r.upstream_proxy,
    },
    ports: { rangeStart: r.port_range_start, rangeEnd: r.port_range_end },
    state: r.state as Host["state"],
    lastError: r.last_error,
    lastSeenAt: toDate(r.last_seen_at),
    createdAt: new Date(r.created_at),
  };
}

export type PreviewRow = {
  id: string;
  org_id: string;
  project: string;
  host_id: string;
  kind: string;
  state: string;
  source_kind: string;
  source_json: string;
  visibility: string;
  ttl_expires_at: number | null;
  last_seen_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  destroyed_at: number | null;
  idle_after_ms?: number | null;
  secret_level?: string | null;
  template_id?: string | null;
  project_id?: string | null;
  password_mode?: string | null;
  password_login?: string | null;
  signed_in_only?: number | null;
  watermark?: string | null;
  domain?: string | null;
  title?: string | null;
  icon?: string | null;
  icon_color?: string | null;
};

function rowIcon(name: string, color: string | null | undefined): PreviewIcon {
  return {
    name: name as PreviewIcon["name"],
    color: (color ?? DEFAULT_ICON_COLOR) as PreviewIcon["color"],
  };
}

// The kind has its own column; the rest of the source is JSON.
function rowSource(kind: string, json: string): PreviewSource {
  const source = { kind, ...(JSON.parse(json) as object) };
  return source as PreviewSource;
}

export function rowToPreview(r: PreviewRow): Preview {
  return {
    id: r.id,
    orgId: r.org_id,
    project: r.project,
    title: r.title ?? null,
    icon: r.icon ? rowIcon(r.icon, r.icon_color) : null,
    hostId: r.host_id,
    kind: r.kind as Preview["kind"],
    state: r.state as Preview["state"],
    source: rowSource(r.source_kind, r.source_json),
    visibility: r.visibility as Preview["visibility"],
    ttlExpiresAt: toDate(r.ttl_expires_at),
    idleAfterMs: r.idle_after_ms ?? null,
    secretLevel: (r.secret_level ?? null) as Clearance | null,
    templateId: r.template_id ?? null,
    projectId: r.project_id ?? null,
    password: (r.password_mode ?? "inherit") as Preview["password"],
    passwordLogin: r.signed_in_only
      ? "only"
      : ((r.password_login ?? "inherit") as Preview["passwordLogin"]),
    watermark: (r.watermark ?? "inherit") as Preview["watermark"],
    domain: r.domain ?? null,
    lastSeenAt: toDate(r.last_seen_at),
    error: r.error,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    destroyedAt: toDate(r.destroyed_at),
  };
}

export function sourceToColumns(s: PreviewSource): { source_kind: string; source_json: string } {
  const { kind, ...rest } = s as { kind: string } & Record<string, unknown>;
  return { source_kind: kind, source_json: JSON.stringify(rest) };
}

export type RouteRow = {
  hostname: string;
  preview_id: string;
  service: string;
  container_port: number;
  upstream_host: string;
  upstream_port: number;
  is_primary: number;
  created_at: number;
};

export function rowToRoute(r: RouteRow): Route {
  return {
    hostname: r.hostname,
    previewId: r.preview_id,
    service: r.service,
    containerPort: r.container_port,
    upstream: { host: r.upstream_host, port: r.upstream_port },
    primary: bool(r.is_primary),
    createdAt: new Date(r.created_at),
  };
}

export type EventRow = {
  seq: number;
  preview_id: string | null;
  type: string;
  payload_json: string;
  created_at: number;
};

export function rowToEvent(r: EventRow): GangwayEvent {
  return {
    seq: r.seq,
    previewId: r.preview_id,
    type: r.type,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    createdAt: new Date(r.created_at),
  };
}

export type CertRow = {
  domain: string;
  cert_pem: string;
  key_pem: string;
  chain_pem: string | null;
  issuer: string | null;
  source: string | null;
  not_before: number | null;
  not_after: number | null;
  updated_at: number;
};

export function rowToCert(r: CertRow): Certificate {
  return {
    domain: r.domain,
    certPem: r.cert_pem,
    keyPem: r.key_pem,
    chainPem: r.chain_pem,
    issuer: r.issuer,
    source: r.source,
    notBefore: toDate(r.not_before),
    notAfter: toDate(r.not_after),
    updatedAt: new Date(r.updated_at),
  };
}

export type RoleRow = {
  id: string;
  name: string;
  description: string;
  builtin: number;
  created_at: number;
};

export const rowToRole = (r: RoleRow): Role => ({
  id: r.id,
  name: r.name,
  description: r.description,
  builtin: bool(r.builtin),
  createdAt: new Date(r.created_at),
});

export type SessionRow = {
  id: string;
  user_id: string;
  org_id: string | null;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  ip: string | null;
  user_agent: string | null;
};

export function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    userId: r.user_id,
    orgId: r.org_id ?? HOME_ORG_ID,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    lastSeenAt: toDate(r.last_seen_at),
    ip: r.ip,
    userAgent: r.user_agent,
  };
}

export const TOKEN_COLUMNS =
  "id, name, prefix, scopes, secret_targets, user_id, app_name, expires_at, last_used_at, revoked_at, created_at";
export type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  secret_targets: string | null;
  user_id: string | null;
  app_name: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
};

export const parseTargets = (s: string | null): SecretTargets | null =>
  s === null ? null : (JSON.parse(s) as SecretTargets);

export function rowToToken(r: TokenRow): ApiToken {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: JSON.parse(r.scopes) as Scope[],
    secretTargets: parseTargets(r.secret_targets),
    userId: r.user_id,
    appName: r.app_name,
    expiresAt: toDate(r.expires_at),
    lastUsedAt: toDate(r.last_used_at),
    revokedAt: toDate(r.revoked_at),
    createdAt: new Date(r.created_at),
  };
}

export type AuditRow = {
  seq: number;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  old_json: string | null;
  new_json: string | null;
  created_at: number;
};

export function rowToAuditEntry(r: AuditRow): AuditEntry {
  return {
    seq: r.seq,
    actorType: r.actor_type as AuditActorType,
    actorId: r.actor_id,
    actorName: r.actor_name,
    action: r.action,
    target: r.target,
    old: r.old_json === null ? null : JSON.parse(r.old_json),
    new: r.new_json === null ? null : JSON.parse(r.new_json),
    createdAt: new Date(r.created_at),
  };
}

export type ProjectRow = {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  forge: string | null;
  full_name: string | null;
  installation_id: string;
  pr_trigger: string;
  enabled: number;
  disabled_reason: string | null;
  template_id: string | null;
  visibility: string | null;
  ttl: string | null;
  pr_clearance: string | null;
  forks: string;
  drafts: number;
  fork_clearance: string;
  watermark?: string | null;
  domain?: string | null;
  production_preview_id?: string | null;
  created_at: number;
  updated_at: number;
};

export const rowToProject = (r: ProjectRow): Project => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  slug: r.slug,
  forge: r.forge as ForgeId | null,
  fullName: r.full_name,
  installationId: r.installation_id,
  prTrigger: r.pr_trigger as PrTrigger,
  enabled: bool(r.enabled),
  disabledReason: r.disabled_reason,
  templateId: r.template_id,
  visibility: r.visibility as Visibility | null,
  ttl: r.ttl,
  prClearance: r.pr_clearance as Clearance | null,
  forks: r.forks as ForkPolicy,
  drafts: bool(r.drafts),
  forkClearance: r.fork_clearance as Clearance,
  watermark: (r.watermark ?? null) as Project["watermark"],
  domain: r.domain ?? null,
  productionPreviewId: r.production_preview_id ?? null,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

export type TemplateRow = {
  id: string;
  name: string;
  description: string;
  builtin: number;
  visibility: string;
  ttl: string | null;
  idle_after: string;
  clearance: string;
  host_id: string | null;
  created_at: number;
  updated_at: number;
};

export const rowToTemplate = (r: TemplateRow): Template => ({
  id: r.id,
  name: r.name,
  description: r.description,
  builtin: bool(r.builtin),
  visibility: r.visibility as Visibility,
  ttl: r.ttl,
  idleAfter: r.idle_after,
  clearance: r.clearance as Clearance,
  hostId: r.host_id,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

export type DomainRow = {
  id: string;
  name: string;
  kind: string;
  project_id: string | null;
  preview_id: string | null;
  status: string;
  claim_id: string;
  routing_ok: number;
  last_error: string | null;
  checked_at: number | null;
  verified_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

export const rowToDomain = (r: DomainRow): Domain => ({
  id: r.id,
  name: r.name,
  kind: r.kind as Domain["kind"],
  projectId: r.project_id,
  previewId: r.preview_id,
  status: r.status as Domain["status"],
  claimId: r.claim_id,
  routingOk: bool(r.routing_ok),
  lastError: r.last_error,
  checkedAt: toDate(r.checked_at),
  verifiedAt: toDate(r.verified_at),
  createdBy: r.created_by,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});
