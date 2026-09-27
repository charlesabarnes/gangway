import { Resolver } from "node:dns/promises";

/** The two questions a claim asks of public DNS. */
export interface ClaimDns {
  /** The CNAME targets at a name, lowercased, without the trailing dot; empty when none. */
  cnames(name: string): Promise<string[]>;
  /** The IPv4 and IPv6 addresses a name resolves to, following CNAMEs; empty when none. */
  addresses(name: string): Promise<string[]>;
}

const TIMEOUT_MS = 5_000;
const bare = (n: string) => n.toLowerCase().replace(/\.$/, "");

export function publicClaimDns(): ClaimDns {
  const resolver = () => new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
  return {
    async cnames(name) {
      return (
        await resolver()
          .resolveCname(name)
          .catch(() => [] as string[])
      ).map(bare);
    },
    async addresses(name) {
      const r = resolver();
      const [v4, v6] = await Promise.all([
        r.resolve4(name).catch(() => [] as string[]),
        r.resolve6(name).catch(() => [] as string[]),
      ]);
      return [...v4, ...v6];
    },
  };
}
