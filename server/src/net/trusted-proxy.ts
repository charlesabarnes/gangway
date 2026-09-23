import { BlockList, isIP } from "node:net";

export type ClientIpResolver = (peer: string, forwardedFor: string | null) => string;

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
      // Walking right to left, the first untrusted hop is the last one a trusted proxy vouched for.
      if (isIP(hop) === 0) return peer;
      if (!isTrusted(hop)) return hop;
    }
    return peer;
  };
}
