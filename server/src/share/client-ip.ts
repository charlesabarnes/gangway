import { isIP } from "node:net";
import { unmap } from "../net/trusted-proxy.ts";

/**
 * Whether a connection could be cloudflared's: it dials the listener on loopback, or on the
 * address gangway listens on when that is a single one.
 */
export function tunnelPeerFor(listenAddress: string): (peer: string) => boolean {
  const own = listenAddress === "::" || listenAddress === "0.0.0.0" ? null : unmap(listenAddress);
  return (peer) => {
    const ip = unmap(peer);
    return ip === "127.0.0.1" || ip === "::1" || ip === own;
  };
}

/**
 * The visitor behind a share link. Cloudflare's edge sets CF-Connecting-IP and cloudflared
 * passes it on; a client cannot choose it.
 */
export function tunnelClientIp(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf && isIP(cf) !== 0) return cf;
  const last = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return last && isIP(last) !== 0 ? unmap(last) : null;
}
