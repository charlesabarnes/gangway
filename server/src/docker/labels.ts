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
  const rawVersion = bag[LABEL.version];
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

  const missing: string[] = [];
  const invalid: string[] = [];

  const str = (key: string): string => {
    const v = bag[key];
    if (v === undefined) {
      missing.push(key);
      return "";
    }
    if (v === "") {
      invalid.push(key);
      return "";
    }
    return v;
  };
  const port = (key: string): number => {
    const v = bag[key];
    if (v === undefined) {
      missing.push(key);
      return 0;
    }
    if (!PORT_RE.test(v) || !isPort(Number(v))) {
      invalid.push(key);
      return 0;
    }
    return Number(v);
  };

  const instance = str(LABEL.instance);
  const env = str(LABEL.env);
  const previewId = str(LABEL.previewId);
  const project = str(LABEL.project);
  const service = str(LABEL.service);
  const hostId = str(LABEL.hostId);
  const hostname = str(LABEL.hostname);
  const upstreamHost = str(LABEL.upstreamHost);
  const portValue = port(LABEL.port);
  const containerPort = port(LABEL.containerPort);

  const rawVisibility = bag[LABEL.visibility];
  let visibility: Visibility = "private";
  if (rawVisibility === undefined) missing.push(LABEL.visibility);
  else if (!VISIBILITIES.includes(rawVisibility as Visibility)) invalid.push(LABEL.visibility);
  else visibility = rawVisibility as Visibility;

  const rawPrimary = bag[LABEL.primary];
  let primary = false;
  if (rawPrimary === undefined) missing.push(LABEL.primary);
  else if (rawPrimary !== "true" && rawPrimary !== "false") invalid.push(LABEL.primary);
  else primary = rawPrimary === "true";

  const rawCreatedAt = bag[LABEL.createdAt];
  let createdAt = new Date(0);
  if (rawCreatedAt === undefined) missing.push(LABEL.createdAt);
  else {
    const d = new Date(rawCreatedAt);
    if (Number.isNaN(d.getTime())) invalid.push(LABEL.createdAt);
    else createdAt = d;
  }

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
