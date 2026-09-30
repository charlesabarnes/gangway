import { isIP } from "node:net";
import { normalizeHost } from "@gangway/shared/hostname";
import { parseTrustedProxies, unmap } from "./trusted-proxy.ts";

/** Caddy's on_demand_tls `ask`: 200 for a name gangway answers, so the proxy may get it a certificate. */
export const TLS_ASK_PATH = "/_gangway/tls/ask";

export type TlsAsk = (req: Request, peer: string) => Response | null;

/** Only names that answer today, not every label under a wildcard (the CA's rate limit). */
export function tlsAsk(o: {
  trustedProxies: readonly string[];
  answers: (host: string) => boolean;
}): TlsAsk {
  const trusted = parseTrustedProxies(o.trustedProxies);
  const allowed = (peer: string) => {
    const ip = unmap(peer);
    const family = isIP(ip);
    if (family === 0) {
      return false;
    }
    if (ip === "127.0.0.1" || ip === "::1") {
      return true;
    }
    return trusted.check(ip, family === 4 ? "ipv4" : "ipv6");
  };
  return (req, peer) => {
    const url = new URL(req.url);
    if (url.pathname !== TLS_ASK_PATH) {
      return null;
    }
    if (!allowed(peer)) {
      return new Response("not found", { status: 404 });
    }
    const host = normalizeHost(url.searchParams.get("domain"));
    return host && o.answers(host)
      ? new Response("ok")
      : new Response("gangway does not answer for that name", { status: 404 });
  };
}
