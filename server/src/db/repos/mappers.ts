/** Row <-> domain conversion. The only place epoch-millis integers become Dates. */
import type {
  Certificate, GangwayEvent, Host, HostCapability, Preview, PreviewSource, Route,
} from "../../../../shared/src/domain.ts";

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
