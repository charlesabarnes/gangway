import { labelUnder, normalizeHost, RESERVED_LABELS } from "@gangway/shared/hostname";
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
  table: RouteTable;
  upstream: Upstream;
  limits: Limits;
  surfaceEnabled: (s: Surface) => boolean;
  handlers: Partial<Record<Surface, SurfaceHandler>>;
  wake?: (entry: RouteEntry, req: Request) => Promise<Response | null>;
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

  const label = labelUnder(host, d.baseDomain());
  if (label === null) return misdirectedPage();

  // Reserved regardless of which surfaces are on, or re-enabling one could collide with a live preview.
  if (label === "" || RESERVED_LABELS.has(label)) return toSurface(req, d, host, label, clientIp);

  const entry = d.table.lookup(host);
  if (!entry) return unknownPage(host);

  const gated = d.visibilityGate?.(entry, req, clientIp);
  if (gated) return gated;

  const instead = await notAwake(req, d, host, entry);
  if (instead) return instead;

  if (isWebSocketUpgrade(req)) {
    return new Response("websocket upgrade failed", { status: 400 });
  }

  return proxy(req, d, host, entry, clientIp);
}
