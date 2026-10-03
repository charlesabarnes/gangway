import { stripGangwayCookies } from "./gate.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

function stripHopByHop(h: Headers): void {
  const named =
    h
      .get("connection")
      ?.split(",")
      .map((s) => s.trim().toLowerCase()) ?? [];
  for (const k of [...HOP_BY_HOP, ...named]) {
    h.delete(k);
  }
}

const FORWARDED = [
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "forwarded",
];

export type ForwardContext = {
  clientHost: string;
  clientIp: string;
  publicPort: number;
  scheme?: "http" | "https";
};

// Keep the original Host, and strip client X-Forwarded-* before setting ours so visitors cannot spoof a trusted proxy.
export function buildUpstreamHeaders(req: Request, ctx: ForwardContext): Headers {
  const h = new Headers(req.headers);
  stripHopByHop(h);
  for (const k of FORWARDED) {
    h.delete(k);
  }

  const cookie = stripGangwayCookies(h.get("cookie"));
  if (cookie === null) {
    h.delete("cookie");
  } else {
    h.set("cookie", cookie);
  }

  h.set("host", ctx.clientHost);
  h.set("x-forwarded-for", ctx.clientIp);
  h.set("x-forwarded-proto", ctx.scheme ?? "https");
  h.set("x-forwarded-host", ctx.clientHost);
  h.set("x-forwarded-port", String(ctx.publicPort));
  return h;
}

export function buildResponseHeaders(src: Headers, opts: { unlisted: boolean }): Headers {
  const out = new Headers(src);
  stripHopByHop(out);
  if (opts.unlisted) {
    out.set("x-robots-tag", "noindex, nofollow");
  }
  return out;
}

// A CDN honours these over cache-control, so they could still share a gated preview's responses.
const SHARED_CACHE_HEADERS = [
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "surrogate-control",
];

/**
 * cache-control that lets only the visitor's own browser keep a response: `public` and `private="…"`
 * become `private`, and `s-maxage` (for shared caches only) goes. `no-store` is left as it is.
 */
export function privateCacheControl(value: string | null): string {
  const kept = (value ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "" && !/^(?:public|private\s*=.*|s-maxage\s*=.*)$/i.test(d));
  if (kept.some((d) => /^(?:private|no-store)$/i.test(d))) {
    return kept.join(", ");
  }
  return ["private", ...kept].join(", ");
}

/** The same response, marked so that a CDN or proxy between the visitor and gangway never stores it. */
export function keepFromSharedCaches(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", privateCacheControl(headers.get("cache-control")));
  for (const h of SHARED_CACHE_HEADERS) {
    headers.delete(h);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}
