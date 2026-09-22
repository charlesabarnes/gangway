/**
 * Host-header dispatch (§3.1, §6.1). Deliberately boring, fixed order, exhaustively
 * tested -- every branch here is a security or usability decision.
 */
import { labelUnder, normalizeHost, RESERVED_LABELS } from "../../../shared/src/hostname.ts";
import type { RouteEntry, RouteTable } from "../routing/table.ts";
import { badGatewayPage, buildingPage, busyPage, failedPage, misdirectedPage, payloadTooLargePage, unknownPage, upstreamTimeoutPage, wakingPage } from "./errorpages.ts";
import { isWebSocketUpgrade } from "./headers.ts";
import { release, tryAcquire, type Limits } from "./limits.ts";
import { isBodyTooLarge, isTimeout, type Upstream } from "./upstream.ts";

/** The surfaces a reserved label can route to. */
export type Surface = "app" | "api" | "mcp" | "hooks" | "registry" | "www";

export type SurfaceHandler = (req: Request, ctx: { clientIp: string }) => Response | Promise<Response>;

export type DispatchDeps = {
  baseDomain: () => string;
  table: RouteTable;
  upstream: Upstream;
  limits: Limits;
  /** Read PER REQUEST so a toggle takes effect with no restart (§10.5). */
  surfaceEnabled: (s: Surface) => boolean;
  handlers: Partial<Record<Surface, SurfaceHandler>>;
  /**
   * Wake-on-request (ADR-0012). Resolves with a Response to send instead (the 202 page
   * when the wake is taking long), or null: the preview is awake now, proxy the request.
   */
  wake?: (entry: RouteEntry, req: Request) => Promise<Response | null>;
  /** Visibility gate (§8.3). Returning a Response short-circuits before the upstream. */
  visibilityGate?: (entry: RouteEntry, req: Request) => Response | null;
  logTailFor?: (previewId: string) => string[];
  logUrlFor?: (previewId: string) => string | undefined;
  clientIpFor: (req: Request) => string;
  onProxied?: (entry: RouteEntry) => void;
};

/**
 * `app` and `www` are the same surface; the rest map to themselves. `registry` is
 * reserved but has no handler until the registry app exists (§12).
 */
function surfaceFor(label: string): Surface {
  return (label === "www" ? "app" : label) as Surface;
}

export async function dispatch(req: Request, d: DispatchDeps): Promise<Response> {
  // 1. Normalize: lowercase, strip port, strip trailing dot, reject IDN-unsafe.
  const host = normalizeHost(req.headers.get("host"));
  if (!host) return new Response("bad request", { status: 400 });

  const clientIp = d.clientIpFor(req);

  // 2. Under our base domain at all? Anything else is a misdirect or a scanner.
  const label = labelUnder(host, d.baseDomain());
  if (label === null) return misdirectedPage();

  // 3. Reserved labels -> application surfaces. The reserved set is STATIC and
  //    independent of which surfaces are enabled (§6.2.1): if `mcp` became a valid
  //    preview label while MCP was off, re-enabling it would collide with a live preview.
  if (label === "" || RESERVED_LABELS.has(label)) {
    const surface = label === "" ? "app" : surfaceFor(label);
    // Disabled surfaces return 404, NOT 503 -- do not advertise what is switched off.
    if (!d.surfaceEnabled(surface)) return unknownPage(host);
    const handler = d.handlers[surface];
    if (!handler) return unknownPage(host);
    return handler(req, { clientIp });
  }

  // 4. Preview. One Map lookup: no database, no await.
  const entry = d.table.lookup(host);
  if (!entry) return unknownPage(host);

  // 5. Visibility gate BEFORE the upstream ever sees the request (§6.3).
  const gated = d.visibilityGate?.(entry, req);
  if (gated) return gated;

  // 6. State machine (§6.1), hot path first.
  switch (entry.state) {
    case "awake":
      break;
    case "building":
    case "starting":
      return buildingPage(host, d.logUrlFor?.(entry.previewId));
    case "failed":
      return failedPage(host, d.logTailFor?.(entry.previewId) ?? [], d.logUrlFor?.(entry.previewId));
    case "asleep": {
      if (!d.wake) return wakingPage(host);
      const instead = await d.wake(entry, req);
      if (instead) return instead;
      break; // woke: the entry says awake now; proxy this very request
    }
    case "destroying":
    case "destroyed":
      return unknownPage(host);
  }

  // 7. Upgrade is handled by the listener, which owns the socket. Reaching here means
  //    the upgrade was refused.
  if (isWebSocketUpgrade(req)) {
    return new Response("websocket upgrade failed", { status: 400 });
  }

  // 8. Ordinary proxy, under the per-preview caps.
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
