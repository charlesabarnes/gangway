import { classifyHost, normalizeHost, type HostKind } from "@gangway/shared/hostname";
import type { RouteEntry, RouteTable } from "../routing/table.ts";
import {
  badGatewayPage,
  buildingPage,
  busyPage,
  failedPage,
  misdirectedPage,
  payloadTooLargePage,
  unknownPage,
  upstreamTimeoutPage,
  wakingPage,
} from "./error-pages.ts";
import { isWebSocketUpgrade } from "./headers.ts";
import { release, tryAcquire, type Limits } from "./limits.ts";
import { isBodyTooLarge, isTimeout, type Upstream } from "./upstream.ts";

export type Surface = "app" | "api" | "mcp" | "hooks" | "registry" | "www";

export type SurfaceHandler = (
  req: Request,
  ctx: { clientIp: string },
) => Response | Promise<Response>;

export type DispatchDeps = {
  baseDomain: () => string;
  /** Defaults to baseDomain. */
  previewDomain?: () => string;
  table: RouteTable;
  upstream: Upstream;
  limits: Limits;
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
  logTailFor?: (previewId: string) => string[];
  logUrlFor?: (previewId: string) => string | undefined;
  clientIpFor: (req: Request) => string;
  onProxied?: (entry: RouteEntry) => void;
};

export function hostKind(
  host: string,
  d: Pick<DispatchDeps, "baseDomain" | "previewDomain">,
): HostKind {
  const base = d.baseDomain();
  return classifyHost(host, base, d.previewDomain?.() || base);
}

function surfaceFor(label: string): Surface {
  return (label === "www" ? "app" : label) as Surface;
}

function toSurface(
  req: Request,
  d: DispatchDeps,
  host: string,
  label: string,
  clientIp: string,
): Response | Promise<Response> {
  const surface = label === "" ? "app" : surfaceFor(label);
  if (!d.surfaceEnabled(surface)) return unknownPage(host);
  const control = surface === "app" || surface === "api";
  if (control && d.controlGate && !d.controlGate(req, clientIp)) return unknownPage(host);
  const handler = d.handlers[surface];
  if (!handler) return unknownPage(host);
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
      if (!d.wake) return wakingPage(host);
      return d.wake(entry, req);
    case "destroying":
    case "destroyed":
      return unknownPage(host);
  }
}

async function serveFiles(
  req: Request,
  d: DispatchDeps,
  host: string,
  entry: RouteEntry,
  site: NonNullable<DispatchDeps["site"]>,
): Promise<Response> {
  if (!tryAcquire(entry, d.limits)) return busyPage(host);
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
  d: DispatchDeps,
  host: string,
  entry: RouteEntry,
  clientIp: string,
): Promise<Response> {
  if (!tryAcquire(entry, d.limits)) return busyPage(host);
  try {
    const res = await d.upstream.fetch(req, entry, { clientIp });
    d.onProxied?.(entry);
    return res;
  } catch (e) {
    if (isBodyTooLarge(e)) return payloadTooLargePage();
    if (isTimeout(e)) return upstreamTimeoutPage(host);
    return badGatewayPage(host);
  } finally {
    release(entry);
  }
}

export async function dispatch(req: Request, d: DispatchDeps): Promise<Response> {
  const host = normalizeHost(req.headers.get("host"));
  if (!host) return new Response("bad request", { status: 400 });

  const clientIp = d.clientIpFor(req);

  // Reserved labels route to surfaces regardless of which are on, or re-enabling one could collide with a live preview.
  const kind = hostKind(host, d);
  if (kind.kind === "misdirected") return misdirectedPage();
  // A page on `x.<previewDomain>` loads its fonts from `<previewDomain>`, where nothing else answers.
  if (kind.kind === "unknown") return (await d.font?.(req)) ?? unknownPage(host);
  if (kind.kind === "surface") return toSurface(req, d, host, kind.label, clientIp);

  const entry = d.table.lookup(host);
  if (!entry) return unknownPage(host);

  const gated = d.visibilityGate?.(entry, req, clientIp);
  if (gated) return gated;

  const instead = await notAwake(req, d, host, entry);
  if (instead) return instead;

  if (isWebSocketUpgrade(req)) {
    return new Response("websocket upgrade failed", { status: 400 });
  }

  if (entry.site && d.site) return serveFiles(req, d, host, entry, d.site);
  return proxy(req, d, host, entry, clientIp);
}
