/**
 * Who is the visitor, when gangway is not the first thing they reach?
 *
 * By default gangway faces the internet and the socket peer is the visitor: every inbound
 * X-Forwarded-* is attacker-controlled and ignored. Behind a reverse proxy the peer is always
 * the proxy, so logs, limits and forwarded headers would all name the proxy.
 *
 * X-Forwarded-For is believed only when the peer is inside a configured range, and it is read
 * right to left, skipping trusted hops. Each proxy appends the address it saw, so the rightmost
 * untrusted entry is the last thing a trusted proxy vouched for; everything to its left is
 * whatever the visitor typed.
 */
import { BlockList, isIP } from "node:net";

export type ClientIpResolver = (peer: string, forwardedFor: string | null) => string;

/** `10.0.0.0/8`, `172.17.0.1`, `fd00::/8`. Throws on anything else: a typo here must not mean "trust nobody, silently". */
export function parseTrustedProxies(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const raw of entries) {
    const [addr = "", bits] = raw.trim().split("/");
    const family = isIP(addr);
    if (family === 0)
      throw new Error(`trusted proxy ${JSON.stringify(raw)} is not an IP address or CIDR`);
    const max = family === 4 ? 32 : 128;
    const prefix = bits === undefined ? max : Number(bits);
    if (!/^\d+$/.test(bits ?? String(max)) || prefix > max)
      throw new Error(`trusted proxy ${JSON.stringify(raw)} has an invalid prefix length`);
    list.addSubnet(addr, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

/** A dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d`. Compare and report the v4 form. */
const unmap = (ip: string): string => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip);

export function clientIpResolver(trusted: readonly string[]): ClientIpResolver {
  if (trusted.length === 0) return (peer) => peer;
  const list = parseTrustedProxies(trusted);
  const isTrusted = (ip: string) => {
    const f = isIP(ip);
    return f !== 0 && list.check(ip, f === 4 ? "ipv4" : "ipv6");
  };

  return (peer, forwardedFor) => {
    const direct = unmap(peer);
    if (!forwardedFor || !isTrusted(direct)) return peer;
    const hops = forwardedFor.split(",").map((h) => unmap(h.trim()));
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      // Garbage in the chain ends the walk: nothing to its left was vouched for either.
      if (isIP(hop) === 0) return peer;
      if (!isTrusted(hop)) return hop;
    }
    return peer;
  };
}
