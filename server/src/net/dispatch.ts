import { classifyHost, normalizeHost, type HostKind } from "@gangway/shared/hostname";
import type { RouteEntry, RouteTable } from "../routing/table.ts";
import {
  badGatewayPage,
  buildingPage,
  busyPage,
  failedPage,
  misdirectedPage,
  payloadTooLargePage,
  tooManyPage,
  unknownPage,
  upstreamTimeoutPage,
  wakingPage,
} from "./error-pages.ts";
import { themed } from "./page-chrome.ts";
import { isWebSocketUpgrade, keepFromSharedCaches } from "./headers.ts";
import { release, tryAcquire, type Limits } from "./limits.ts";
import type { RequestRates } from "./rates.ts";
import { isBodyTooLarge, isTimeout, type Upstream } from "./upstream.ts";
import {
  forMark,
  MARK_PATH,
  markModeOf,
  markResponse,
  stamp,
  wantsMark,
  type MarkMode,
  type Stamp,
} from "./watermark.ts";

export type Surface = "app" | "api" | "mcp" | "hooks" | "registry" | "www";

export type SurfaceHandler = (
  req: Request,
  ctx: { clientIp: string },
) => Response | Promise<Response>;

export type DispatchDeps = {
  baseDomain: () => string;
  /** Every wildcard domain previews are named under; defaults to baseDomain. */
  previewDomains?: () => readonly string[];
  table: RouteTable;
  upstream: Upstream;
  limits: Limits;
  /** Request and socket rates for preview traffic, per client and per preview. */
  rates?: RequestRates | undefined;
  surfaceEnabled: (s: Surface) => boolean;
  /** When set, the UI and API answer only the clients it allows. */
  controlGate?: ((req: Request, clientIp: string) => boolean) | undefined;
  handlers: Partial<Record<Surface, SurfaceHandler>>;
  wake?: (entry: RouteEntry, req: Request) => Promise<Response | null>;
  /** The fonts gangway's own pages load from the parent of the host they stand in for. */
  font?: (req: Request) => Promise<Response | null>;
  /** Answers a route whose files gangway serves itself. */
  site?: (req: Request, entry: RouteEntry) => Promise<Response>;
  visibilityGate?: (
    entry: RouteEntry,
    req: Request,
    clientIp?: string,
  ) => Response | Promise<Response> | null;
  /** Whether a preview asks for a sign-in or a password; its responses are then kept from shared caches. */
  restricted?: (entry: RouteEntry) => boolean;
  logTailFor?: (previewId: string) => string[];
  logUrlFor?: (previewId: string) => string | undefined;
  clientIpFor: (req: Request) => string;
  onProxied?: (entry: RouteEntry) => void;
  /** The gangway watermark: what a preview's pages carry (the mark, a report link, nothing) and its script. */
  watermark?:
    | {
        mode: (entry: RouteEntry) => MarkMode | null;
        script: (mode: MarkMode) => string;
        /** Changes with the settings the script draws, so browsers fetch the new one. */
        version: () => string;
      }
    | undefined;
};

export function hostKind(
  host: string,
  d: Pick<DispatchDeps, "baseDomain" | "previewDomains" | "table">,
): HostKind {
  const base = d.baseDomain();
  const domains = d.previewDomains?.() ?? [];
  const kind = classifyHost(host, base, domains.length > 0 ? domains : [base]);
  // A custom hostname sits under none of them.
  if (kind.kind === "misdirected" && d.table.lookup(host)) {
    return { kind: "preview" };
  }
  return kind;
}

function surfaceFor(label: string): Surface {
  return (label === "www" ? "app" : label) as Surface;
}

/** One request's routing context: the deps, the normalized host and the client. */
type Visit = { d: DispatchDeps; host: string; clientIp: string };

function toSurface(
  req: Request,
  { d, host, clientIp }: Visit,
  label: string,
): Response | Promise<Response> {
  const surface = label === "" ? "app" : surfaceFor(label);
  if (!d.surfaceEnabled(surface)) {
    return unknownPage(host);
  }
  const control = surface === "app" || surface === "api";
  if (control && d.controlGate && !d.controlGate(req, clientIp)) {
    return unknownPage(host);
  }
  const handler = d.handlers[surface];
  if (!handler) {
    return unknownPage(host);
  }
  return handler(req, { clientIp });
}

async function notAwake(
  req: Request,
  d: DispatchDeps,
  host: string,
  entry: RouteEntry,
): Promise<Response | null> {
  switch (entry.state) {
    case "awake":
      return null;
    case "building":
    case "starting":
      return buildingPage(host, d.logUrlFor?.(entry.previewId));
    case "failed":
      return failedPage(
        host,
        d.logTailFor?.(entry.previewId) ?? [],
        d.logUrlFor?.(entry.previewId),
      );
    case "asleep":
      if (!d.wake) {
        return wakingPage(host);
      }
      return d.wake(entry, req);
    case "destroying":
    case "destroyed":
      return unknownPage(host);
  }
}

async function serveFiles(
  req: Request,
  { d, host }: Visit,
  entry: RouteEntry,
  site: NonNullable<DispatchDeps["site"]>,
): Promise<Response> {
  if (!tryAcquire(entry, d.limits)) {
    return busyPage(host);
  }
  try {
    const res = await site(req, entry);
    d.onProxied?.(entry);
    return res;
  } finally {
    release(entry);
  }
}

async function proxy(
  req: Request,
  { d, host, clientIp }: Visit,
  entry: RouteEntry,
): Promise<Response> {
  if (!tryAcquire(entry, d.limits)) {
    return busyPage(host);
  }
  try {
    const res = await d.upstream.fetch(req, entry, { clientIp });
    d.onProxied?.(entry);
    return res;
  } catch (e) {
    if (isBodyTooLarge(e)) {
      return payloadTooLargePage();
    }
    if (isTimeout(e)) {
      return upstreamTimeoutPage(host);
    }
    return badGatewayPage(host);
  } finally {
    release(entry);
  }
}

export async function dispatch(req: Request, d: DispatchDeps): Promise<Response> {
  return themed(await route(req, d), req);
}

async function route(req: Request, d: DispatchDeps): Promise<Response> {
  const host = normalizeHost(req.headers.get("host"));
  if (!host) {
    return new Response("bad request", { status: 400 });
  }

  const clientIp = d.clientIpFor(req);
  const visit: Visit = { d, host, clientIp };

  // Reserved labels route to surfaces regardless of which are on, or re-enabling one could collide with a live preview.
  const kind = hostKind(host, d);
  if (kind.kind === "misdirected") {
    return misdirectedPage();
  }
  // A page on `x.<previewDomain>` loads its fonts from `<previewDomain>`, where nothing else answers.
  if (kind.kind === "unknown") {
    return (await d.font?.(req)) ?? unknownPage(host);
  }
  if (kind.kind === "surface") {
    return toSurface(req, visit, kind.label);
  }

  const entry = d.table.lookup(host);
  if (!entry) {
    return unknownPage(host);
  }
  const wait = d.rates?.take(clientIp, entry.previewId);
  if (wait) {
    return tooManyPage(host, wait);
  }
  if (d.watermark && req.url.includes(MARK_PATH)) {
    const url = new URL(req.url);
    if (url.pathname === MARK_PATH) {
      return markResponse(req, d.watermark.script(markModeOf(url)));
    }
  }

  const gated = d.visibilityGate?.(entry, req, clientIp);
  if (gated) {
    return gated;
  }

  const instead = await notAwake(req, d, host, entry);
  if (instead) {
    return instead;
  }

  if (isWebSocketUpgrade(req)) {
    return new Response("websocket upgrade failed", { status: 400 });
  }

  return respond(req, visit, entry);
}

async function respond(req: Request, visit: Visit, entry: RouteEntry): Promise<Response> {
  const { d } = visit;
  const mode = d.watermark && wantsMark(req) ? d.watermark.mode(entry) : null;
  const s: Stamp | null =
    d.watermark && mode !== null ? { mode, version: d.watermark.version() } : null;
  const res =
    s === null
      ? await answer(req, visit, entry)
      : stamp(await answer(forMark(req, s), visit, entry), req, s);
  // A CDN in front would otherwise hand a gated preview's files to people who never passed the gate.
  return d.restricted?.(entry) ? keepFromSharedCaches(res) : res;
}

function answer(req: Request, visit: Visit, entry: RouteEntry): Promise<Response> {
  const { site } = visit.d;
  if (entry.site && site) {
    return serveFiles(req, visit, entry, site);
  }
  return proxy(req, visit, entry);
}
