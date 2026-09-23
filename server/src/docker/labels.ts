import type { Route, Visibility } from "@gangway/shared/domain";

// Bump when a key's meaning changes, not when one is added.
export const CURRENT_LABEL_VERSION = 1;

export const LABEL = {
  managed: "gangway.managed",
  version: "gangway.version",
  instance: "gangway.instance",
  env: "gangway.env",
  previewId: "gangway.preview_id",
  project: "gangway.project",
  service: "gangway.service",
  hostId: "gangway.host_id",
  hostname: "gangway.hostname",
  port: "gangway.port",
  visibility: "gangway.visibility",
  primary: "gangway.primary",
  createdAt: "gangway.created_at",

  containerPort: "gangway.container_port",
  upstreamHost: "gangway.upstream_host",
} as const;

export const MANAGED_FILTER = "gangway.managed=true";

const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private"];

export type GangwayLabels = {
  instance: string;
  env: string;
  previewId: string;
  project: string;
  service: string;
  hostId: string;
  hostname: string;
  port: number;
  containerPort: number;
  upstreamHost: string;
  visibility: Visibility;
  primary: boolean;
  createdAt: Date;
};

export type LabelParseFailure =
  | { ok: false; reason: "not-managed" }
  | { ok: false; reason: "future-version"; version: number; ours: number }
  | { ok: false; reason: "malformed"; missing: string[]; invalid: string[] };

export type LabelParseResult = { ok: true; labels: GangwayLabels } | LabelParseFailure;

const PORT_RE = /^\d{1,5}$/;

function isPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function buildLabels(l: GangwayLabels): Record<string, string> {
  return {
    [LABEL.managed]: "true",
    [LABEL.version]: String(CURRENT_LABEL_VERSION),
    [LABEL.instance]: l.instance,
    [LABEL.env]: l.env,
    [LABEL.previewId]: l.previewId,
    [LABEL.project]: l.project,
    [LABEL.service]: l.service,
    [LABEL.hostId]: l.hostId,
    [LABEL.hostname]: l.hostname,
    [LABEL.port]: String(l.port),
    [LABEL.containerPort]: String(l.containerPort),
    [LABEL.upstreamHost]: l.upstreamHost,
    [LABEL.visibility]: l.visibility,
    [LABEL.primary]: l.primary ? "true" : "false",
    [LABEL.createdAt]: l.createdAt.toISOString(),
  };
}

export function isManaged(raw: Readonly<Record<string, string>> | null | undefined): boolean {
  return raw?.[LABEL.managed] === "true";
}

export function parseLabels(
  raw: Readonly<Record<string, string>> | null | undefined,
): LabelParseResult {
  const bag = raw ?? {};
  if (!isManaged(bag)) return { ok: false, reason: "not-managed" };

  // Version first: a newer gangway's labels must not be read as malformed and stopped.
  const refused = checkVersion(bag[LABEL.version]);
  if (refused) return refused;

  const { read, missing, invalid } = labelReader(bag);
  const instance = read(LABEL.instance, "", nonEmpty);
  const env = read(LABEL.env, "", nonEmpty);
  const previewId = read(LABEL.previewId, "", nonEmpty);
  const project = read(LABEL.project, "", nonEmpty);
  const service = read(LABEL.service, "", nonEmpty);
  const hostId = read(LABEL.hostId, "", nonEmpty);
  const hostname = read(LABEL.hostname, "", nonEmpty);
  const upstreamHost = read(LABEL.upstreamHost, "", nonEmpty);
  const portValue = read(LABEL.port, 0, portOf);
  const containerPort = read(LABEL.containerPort, 0, portOf);
  const visibility = read<Visibility>(LABEL.visibility, "private", visibilityOf);
  const primary = read(LABEL.primary, false, booleanOf);
  const createdAt = read(LABEL.createdAt, new Date(0), dateOf);

  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, reason: "malformed", missing, invalid };
  }

  return {
    ok: true,
    labels: {
      instance,
      env,
      previewId,
      project,
      service,
      hostId,
      hostname,
      port: portValue,
      containerPort,
      upstreamHost,
      visibility,
      primary,
      createdAt,
    },
  };
}

function checkVersion(rawVersion: string | undefined): LabelParseFailure | undefined {
  const version = rawVersion === undefined ? Number.NaN : Number(rawVersion);
  if (!Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      reason: "malformed",
      missing: rawVersion === undefined ? [LABEL.version] : [],
      invalid: rawVersion === undefined ? [] : [LABEL.version],
    };
  }
  if (version > CURRENT_LABEL_VERSION) {
    return { ok: false, reason: "future-version", version, ours: CURRENT_LABEL_VERSION };
  }
  return undefined;
}

function labelReader(bag: Readonly<Record<string, string>>) {
  const missing: string[] = [];
  const invalid: string[] = [];
  const read = <T>(key: string, fallback: T, parse: (v: string) => T | undefined): T => {
    const v = bag[key];
    if (v === undefined) {
      missing.push(key);
      return fallback;
    }
    const parsed = parse(v);
    if (parsed === undefined) {
      invalid.push(key);
      return fallback;
    }
    return parsed;
  };
  return { read, missing, invalid };
}

const nonEmpty = (v: string): string | undefined => (v === "" ? undefined : v);

const portOf = (v: string): number | undefined =>
  PORT_RE.test(v) && isPort(Number(v)) ? Number(v) : undefined;

const visibilityOf = (v: string): Visibility | undefined =>
  VISIBILITIES.includes(v as Visibility) ? (v as Visibility) : undefined;

const booleanOf = (v: string): boolean | undefined =>
  v === "true" || v === "false" ? v === "true" : undefined;

function dateOf(v: string): Date | undefined {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function routeFromLabels(l: GangwayLabels): Route {
  return {
    hostname: l.hostname,
    previewId: l.previewId,
    service: l.service,
    containerPort: l.containerPort,
    upstream: { host: l.upstreamHost, port: l.port },
    primary: l.primary,
    createdAt: l.createdAt,
  };
}

export type LabelContext = {
  instance: string;
  env: string;
  project: string;
  hostId: string;
  visibility: Visibility;
};

export function labelsFromRoute(route: Route, ctx: LabelContext): GangwayLabels {
  return {
    instance: ctx.instance,
    env: ctx.env,
    previewId: route.previewId,
    project: ctx.project,
    service: route.service,
    hostId: ctx.hostId,
    hostname: route.hostname,
    port: route.upstream.port,
    containerPort: route.containerPort,
    upstreamHost: route.upstream.host,
    visibility: ctx.visibility,
    primary: route.primary,
    createdAt: route.createdAt,
  };
}

export function containerLabels(route: Route, ctx: LabelContext): Record<string, string> {
  return buildLabels(labelsFromRoute(route, ctx));
}
