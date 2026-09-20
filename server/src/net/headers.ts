/**
 * Header handling for the proxy leg. Every rule here is a bug report if missed (§6.4).
 */
export const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "proxy-authenticate", "proxy-authorization",
]);

/** Removes hop-by-hop headers, including any the Connection header names. */
export function stripHopByHop(h: Headers): void {
  const named = h.get("connection")?.split(",").map((s) => s.trim().toLowerCase()) ?? [];
  for (const k of [...HOP_BY_HOP, ...named]) h.delete(k);
}

const FORWARDED = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "forwarded"];

export type ForwardContext = {
  clientHost: string;
  clientIp: string;
  publicPort: number;
  scheme?: "http" | "https";
};

/**
 * Builds the upstream request headers.
 *
 * Two rules matter most. The original Host is PRESERVED -- frameworks build absolute URLs
 * from it and will otherwise redirect visitors to http://localhost. And client-supplied
 * X-Forwarded-* are stripped BEFORE ours are set, so a visitor cannot spoof their way past
 * a framework's trusted-proxy check.
 */
export function buildUpstreamHeaders(req: Request, ctx: ForwardContext): Headers {
  const h = new Headers(req.headers);
  stripHopByHop(h);
  for (const k of FORWARDED) h.delete(k);

  h.set("host", ctx.clientHost);
  h.set("x-forwarded-for", ctx.clientIp);
  h.set("x-forwarded-proto", ctx.scheme ?? "https");
  h.set("x-forwarded-host", ctx.clientHost);
  h.set("x-forwarded-port", String(ctx.publicPort));
  return h;
}

/** Cleans a response before it goes back to the visitor. */
export function buildResponseHeaders(src: Headers, opts: { unlisted: boolean }): Headers {
  const out = new Headers(src);
  stripHopByHop(out);
  // unlisted previews are unauthenticated but must not be indexed (§8.3).
  if (opts.unlisted) out.set("x-robots-tag", "noindex, nofollow");
  return out;
}

export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}
