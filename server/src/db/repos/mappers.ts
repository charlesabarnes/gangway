/** Row <-> domain conversion. The only place epoch-millis integers become Dates. */
import type {
  ApiToken, AuditActorType, AuditEntry, Certificate, ForgeId, ForkPolicy, GangwayEvent, Host, HostCapability, Preview, PreviewSource, Repo,
  Role, Route, Session, User, Visibility,
} from "../../../../shared/src/domain.ts";
import type { Scope } from "../../../../shared/src/permissions.ts";

export const toDate = (n: number | null | undefined): Date | null =>
  n === null || n === undefined ? null : new Date(n);
export const fromDate = (d: Date | null | undefined): number | null =>
  d === null || d === undefined ? null : d.getTime();
export const bool = (n: number): boolean => n === 1;
export const num = (b: boolean): number => (b ? 1 : 0);

export type HostRow = {
  id: string; name: string; docker_host: string; expect_name: string | null;
  capabilities: string; publish_bind: string; upstream_dial: string;
  upstream_address: string; upstream_proxy: string | null;
  port_range_start: number; port_range_end: number;
  state: string; last_error: string | null; last_seen_at: number | null; created_at: number;
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
  id: string; project: string; host_id: string; kind: string; state: string;
  source_kind: string; source_json: string; visibility: string;
  ttl_expires_at: number | null; last_seen_at: number | null; error: string | null;
  created_at: number; updated_at: number; destroyed_at: number | null;
  idle_after_ms?: number | null;
};

export function rowToPreview(r: PreviewRow): Preview {
  return {
    id: r.id,
    project: r.project,
    hostId: r.host_id,
    kind: r.kind as Preview["kind"],
    state: r.state as Preview["state"],
    source: { kind: r.source_kind, ...JSON.parse(r.source_json) } as PreviewSource,
    visibility: r.visibility as Preview["visibility"],
    ttlExpiresAt: toDate(r.ttl_expires_at),
    idleAfterMs: r.idle_after_ms ?? null,
    lastSeenAt: toDate(r.last_seen_at),
    error: r.error,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    destroyedAt: toDate(r.destroyed_at),
  };
}

/** Splits a discriminated source into its column and its payload. */
export function sourceToColumns(s: PreviewSource): { source_kind: string; source_json: string } {
  const { kind, ...rest } = s as { kind: string } & Record<string, unknown>;
  return { source_kind: kind, source_json: JSON.stringify(rest) };
}

export type RouteRow = {
  hostname: string; preview_id: string; service: string; container_port: number;
  upstream_host: string; upstream_port: number; is_primary: number; created_at: number;
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
  seq: number; preview_id: string | null; type: string; payload_json: string; created_at: number;
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
  domain: string; cert_pem: string; key_pem: string; chain_pem: string | null;
  issuer: string | null; source: string | null; not_before: number | null; not_after: number | null; updated_at: number;
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

/* ------------------------------------------------------------------ accounts (§8) */

export type RoleRow = { id: string; name: string; description: string; builtin: number; created_at: number };

export const rowToRole = (r: RoleRow): Role =>
  ({ id: r.id, name: r.name, description: r.description, builtin: bool(r.builtin), createdAt: new Date(r.created_at) });

/** The columns a `User` is made of. Password material is deliberately NOT among them. */
export const USER_COLUMNS = "id, email, role_id, disabled, created_at";
export type UserRow = { id: string; email: string; role_id: string; disabled: number; created_at: number };

export const rowToUser = (r: UserRow): User =>
  ({ id: r.id, email: r.email, roleId: r.role_id, disabled: bool(r.disabled), createdAt: new Date(r.created_at) });

export type SessionRow = {
  id: string; user_id: string; created_at: number; expires_at: number;
  last_seen_at: number | null; ip: string | null; user_agent: string | null;
};

export function rowToSession(r: SessionRow): Session {
  return {
    id: r.id, userId: r.user_id, createdAt: new Date(r.created_at), expiresAt: new Date(r.expires_at),
    lastSeenAt: toDate(r.last_seen_at), ip: r.ip, userAgent: r.user_agent,
  };
}

/** Everything but `token_hash`: a listing has no use for it, so it never leaves the repo. */
export const TOKEN_COLUMNS = "id, name, prefix, scopes, user_id, app_name, expires_at, last_used_at, revoked_at, created_at";
export type TokenRow = {
  id: string; name: string; prefix: string; scopes: string; user_id: string | null; app_name: string | null;
  expires_at: number | null; last_used_at: number | null; revoked_at: number | null; created_at: number;
};

export function rowToToken(r: TokenRow): ApiToken {
  return {
    id: r.id, name: r.name, prefix: r.prefix, scopes: JSON.parse(r.scopes) as Scope[],
    userId: r.user_id, appName: r.app_name,
    expiresAt: toDate(r.expires_at), lastUsedAt: toDate(r.last_used_at), revokedAt: toDate(r.revoked_at),
    createdAt: new Date(r.created_at),
  };
}

export type AuditRow = {
  seq: number; actor_type: string; actor_id: string | null; action: string; target: string | null;
  old_json: string | null; new_json: string | null; created_at: number;
};

export function rowToAuditEntry(r: AuditRow): AuditEntry {
  return {
    seq: r.seq, actorType: r.actor_type as AuditActorType, actorId: r.actor_id, action: r.action, target: r.target,
    old: r.old_json === null ? null : JSON.parse(r.old_json), new: r.new_json === null ? null : JSON.parse(r.new_json),
    createdAt: new Date(r.created_at),
  };
}

export type RepoRow = {
  id: string; forge: string; full_name: string; installation_id: string; slug: string; enabled: number;
  disabled_reason: string | null; visibility: string | null; ttl: string | null; forks: string; drafts: number;
  created_at: number; updated_at: number;
};

export const rowToRepo = (r: RepoRow): Repo => ({
  id: r.id, forge: r.forge as ForgeId, fullName: r.full_name, installationId: r.installation_id, slug: r.slug,
  enabled: bool(r.enabled), disabledReason: r.disabled_reason, visibility: r.visibility as Visibility | null, ttl: r.ttl,
  forks: r.forks as ForkPolicy, drafts: bool(r.drafts), createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
});
