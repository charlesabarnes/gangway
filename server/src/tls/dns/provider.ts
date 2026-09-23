import { Resolver } from "node:dns/promises";
import { AppError } from "../../errors.ts";
import { Logger } from "../../logger.ts";
import { waitFor } from "../../util/async.ts";

export interface DnsProvider {
  createTxt(name: string, value: string): Promise<{ recordId: string }>;
  removeTxt(recordId: string, name: string): Promise<void>;
  waitForPropagation(name: string, expectedValues: string[]): Promise<boolean>;
}

export interface DnsQueries {
  resolveNs(zone: string): Promise<string[]>;
  resolveAddresses(host: string): Promise<string[]>;
  resolveTxtFrom(serverIp: string, name: string): Promise<string[]>;
}

const QUERY_TIMEOUT_MS = 5_000;

export function nodeDnsQueries(): DnsQueries {
  return {
    async resolveNs(zone) {
      return await new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 2 }).resolveNs(zone);
    },
    async resolveAddresses(host) {
      const r = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 2 });
      // IPv4 first: a v6 route that blackholes is more common than v6-only egress.
      const v4 = await r.resolve4(host).catch(() => [] as string[]);
      if (v4.length > 0) return v4;
      return await r.resolve6(host).catch(() => [] as string[]);
    },
    async resolveTxtFrom(serverIp, name) {
      const r = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 2 });
      r.setServers([serverIp]);
      // Long TXT values arrive as several strings of up to 255 bytes.
      return (await r.resolveTxt(name)).map((chunks) => chunks.join(""));
    },
  };
}

export function zoneCandidates(name: string): string[] {
  const labels = name
    .replace(/\.$/, "")
    .split(".")
    .filter((l) => l.length > 0);
  const out: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i++) {
    const first = labels[i];
    if (first === undefined || first.startsWith("_")) continue;
    out.push(labels.slice(i).join("."));
  }
  return out;
}

async function findZone(name: string, dns: DnsQueries): Promise<string> {
  for (const candidate of zoneCandidates(name)) {
    const ns = await dns.resolveNs(candidate).catch(() => [] as string[]);
    if (ns.length > 0) return candidate;
  }
  throw new AppError("unavailable", `no delegated DNS zone found for ${name}`, { name });
}

export type PropagationOptions = {
  dns?: DnsQueries;
  zone?: string;
  timeoutMs?: number;
  intervalMs?: number;
  log?: Logger;
  signal?: AbortSignal;
};

// Every authoritative server: resolvers cache negative answers and the CA may ask any server.
export async function waitForTxtPropagation(
  name: string,
  expectedValues: string[],
  o: PropagationOptions = {},
): Promise<boolean> {
  const dns = o.dns ?? nodeDnsQueries();
  const log = o.log ?? new Logger("info", { component: "tls/dns" });
  const zone = o.zone ?? (await findZone(name, dns));

  const nameservers = await dns.resolveNs(zone);
  const addresses = [
    ...new Set(
      (
        await Promise.all(
          nameservers.map((ns) => dns.resolveAddresses(ns).catch(() => [] as string[])),
        )
      ).flat(),
    ),
  ];
  if (addresses.length === 0) {
    throw new AppError("unavailable", `no authoritative nameserver addresses for zone ${zone}`, {
      zone,
      nameservers,
    });
  }

  const wanted = [...new Set(expectedValues)];
  log.debug("polling authoritative nameservers for TXT propagation", {
    name,
    zone,
    nameservers,
    servers: addresses.length,
    expected: wanted.length,
  });

  const settled = await waitFor(
    async () => {
      const perServer = await Promise.all(
        addresses.map(async (ip) => {
          const values = await dns.resolveTxtFrom(ip, name).catch(() => [] as string[]);
          return wanted.every((v) => values.includes(v));
        }),
      );
      const ready = perServer.filter(Boolean).length;
      if (ready === addresses.length) return true;
      log.debug("TXT not yet visible everywhere", { name, ready, of: addresses.length });
      return null;
    },
    {
      timeoutMs: o.timeoutMs ?? 120_000,
      intervalMs: o.intervalMs ?? 2_000,
      ...(o.signal ? { signal: o.signal } : {}),
    },
  );

  if (settled === null) {
    log.warn("TXT records did not propagate before the deadline", {
      name,
      zone,
      servers: addresses.length,
    });
    return false;
  }
  log.info("TXT records visible on every authoritative nameserver", {
    name,
    zone,
    servers: addresses.length,
  });
  return true;
}
