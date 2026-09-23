/**
 * The `gangway.*` container label set (spec §4.1).
 *
 * §4.1's claim is that a container is *self-describing*: the Docker daemon holds an
 * independent second copy of the route record, so reconciliation (§11) always has an
 * answer when SQLite is behind or gone. That claim only holds if the label set is
 * SUFFICIENT — `routeFromLabels` must produce a complete `Route` with nothing else in
 * hand, not "a Route, if you also still have the database row".
 *
 * ADR-0004 is what makes that possible: because we allocate the upstream port ourselves
 * before `compose up`, `gangway.port` is knowable at container-create time and can go
 * into the labels. Reading the port back off the daemon afterwards would have left the
 * labels incomplete at exactly the moment they matter.
 *
 * Nothing here throws. Labels are attacker-adjacent data (a developer's compose file can
 * set any label it likes) and the reconciler must be able to say "this is not mine" or
 * "this is newer than me" rather than crash a boot-time sweep.
 */
import type { Route, Visibility } from "../../../shared/src/domain.ts";

export const LABEL_PREFIX = "gangway.";

/**
 * Bump when the MEANING of a key changes, not when one is added. A newer gangway's
 * containers are reported distinctly (`future-version`) so an older one leaves them
 * alone instead of deciding they are unlabelled orphans and stopping them.
 */
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

  /**
   * Extensions beyond the thirteen keys in the spec's illustrative list. Both are
   * required by §4.1's *sufficiency* claim and by nothing else: `Route` carries
   * `containerPort` and `upstream.host`, and without these two a rebuilt route would
   * have to be completed from the hosts table — i.e. from SQLite, the copy we are
   * recovering from.
   */
  containerPort: "gangway.container_port",
  upstreamHost: "gangway.upstream_host",
} as const;

/** Every key we write. Useful for asserting nothing was dropped. */
export const LABEL_KEYS: readonly string[] = Object.values(LABEL);

/** The daemon-side filter for a managed-container scan (§11 step 2). */
export const MANAGED_FILTER = "gangway.managed=true";

const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private"];

/**
 * The decoded label payload. This is the whole second copy of state: everything the
 * reconciler needs to rebuild a route row and to decide whose container this is.
 */
export type GangwayLabels = {
  /** Which gangway installation wrote this. Two installations may share one daemon. */
  instance: string;
  /** Deployment environment (`prod`, `dev`, …). Same reason as `instance`, finer grain. */
  env: string;
  previewId: string;
  /** Compose project name — the teardown unit (§7.1: `down -v` removes all of it). */
  project: string;
  service: string;
  hostId: string;
  hostname: string;
  /** The self-allocated published port on the host (ADR-0004). */
  port: number;
  /** The port inside the container that `port` is published from. */
  containerPort: number;
  /** How the proxy dials the published port; `Host.upstream.address` at create time. */
  upstreamHost: string;
  visibility: Visibility;
  primary: boolean;
  createdAt: Date;
};

export type LabelParseFailure =
  /** No `gangway.managed=true`. Someone else's container; not ours to touch. */
  | { ok: false; reason: "not-managed" }
  /** Written by a newer gangway. WARN and leave it alone — do not stop it. */
  | { ok: false; reason: "future-version"; version: number; ours: number }
  /** Ours, but unusable. §11: an orphan holding a port is worse than a missing preview. */
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

/** True if the label bag claims to be ours at all. Cheap pre-filter for a scan. */
export function isManaged(raw: Readonly<Record<string, string>> | null | undefined): boolean {
  return raw?.[LABEL.managed] === "true";
}

export function parseLabels(
  raw: Readonly<Record<string, string>> | null | undefined,
): LabelParseResult {
  const bag = raw ?? {};
  if (!isManaged(bag)) return { ok: false, reason: "not-managed" };

  // Version is checked BEFORE the fields. A newer gangway may have renamed or dropped
  // keys we consider mandatory; reporting that as `malformed` would invite the
  // reconciler to treat a perfectly healthy newer preview as an orphan and stop it.
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

/**
 * §11, row 3: "No route / Container running -> Rebuild the route from labels."
 * No database, no host record, no daemon round-trip.
 */
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

/** The forward direction: a route we are about to create becomes the container's labels. */
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

/** Convenience for the compose/create path: labels for a container, as Docker wants them. */
export function containerLabels(route: Route, ctx: LabelContext): Record<string, string> {
  return buildLabels(labelsFromRoute(route, ctx));
}
