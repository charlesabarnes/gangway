/**
 * DNS-01 provider contract (§6.2), plus the propagation poller both implementations share.
 *
 * Two properties of DNS-01 shape this interface and are easy to get wrong:
 *
 * 1. `createTxt` ADDS a record; it is not an upsert. A wildcard order covers two
 *    identifiers (`*.preview.example.com` and `preview.example.com`) that validate at the
 *    SAME `_acme-challenge.preview.example.com` name with DIFFERENT values. Replacing
 *    instead of adding passes or fails depending on which authorization Let's Encrypt
 *    checks first, i.e. about half the time. Hence a record id per call, so cleanup can
 *    remove exactly what it created rather than everything at that name.
 * 2. `waitForPropagation` asks the zone's own authoritative servers. A recursive resolver
 *    (1.1.1.1, or the system one) caches the negative answer from before the record
 *    existed and keeps serving it for the duration of the SOA minimum, so "propagated"
 *    reads as false long after the record is live -- or, worse, reads as true from a
 *    resolver that is not the one Let's Encrypt will ask.
 */
import { Resolver } from "node:dns/promises";
import { AppError } from "../../errors.ts";
import { Logger } from "../../logger.ts";
import { waitFor } from "../../util/async.ts";

export interface DnsProvider {
  /** Adds one TXT record. Never replaces an existing record at `name`. */
  createTxt(name: string, value: string): Promise<{ recordId: string }>;
  /** Removes a record created by `createTxt`. Idempotent: callers run it in a `finally`. */
  removeTxt(recordId: string, name: string): Promise<void>;
  /** True once every expected value is visible on every authoritative nameserver. */
  waitForPropagation(name: string, expectedValues: string[]): Promise<boolean>;
}

/** The DNS lookups the poller needs, injectable so tests never touch the network. */
export interface DnsQueries {
  /** Authoritative nameserver hostnames for a zone. */
  resolveNs(zone: string): Promise<string[]>;
  /** IP addresses for a nameserver hostname. */
  resolveAddresses(host: string): Promise<string[]>;
  /** TXT values at `name`, asked of exactly this server and nothing else. */
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
      // IPv4 first: a v6-only egress path is far rarer than a v6 route that blackholes.
      const v4 = await r.resolve4(host).catch(() => [] as string[]);
      if (v4.length > 0) return v4;
      return await r.resolve6(host).catch(() => [] as string[]);
    },
    async resolveTxtFrom(serverIp, name) {
      const r = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 2 });
      r.setServers([serverIp]);
      // Long TXT values arrive as several <=255-byte strings that must be concatenated.
      return (await r.resolveTxt(name)).map((chunks) => chunks.join(""));
    },
  };
}

/**
 * Zone candidates for `name`, most specific first.
 *
 * `_acme-challenge.preview.example.com` yields `preview.example.com`, `example.com`. Most
 * specific first so that a genuinely delegated `preview.example.com` zone wins when one
 * exists, while the ordinary case still lands on `example.com`. Underscore labels are
 * skipped: `_acme-challenge.…` is never a zone, and asking costs a round trip.
 */
export function zoneCandidates(name: string): string[] {
  const labels = name.replace(/\.$/, "").split(".").filter((l) => l.length > 0);
  const out: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i++) {
    const first = labels[i];
    if (first === undefined || first.startsWith("_")) continue;
    out.push(labels.slice(i).join("."));
  }
  return out;
}

/** Walks up from `name` until a level answers NS, i.e. the closest enclosing zone. */
export async function findZone(name: string, dns: DnsQueries): Promise<string> {
  for (const candidate of zoneCandidates(name)) {
    const ns = await dns.resolveNs(candidate).catch(() => [] as string[]);
    if (ns.length > 0) return candidate;
  }
  throw new AppError("unavailable", `no delegated DNS zone found for ${name}`, { name });
}

export type PropagationOptions = {
  dns?: DnsQueries;
  /** The delegated zone whose nameservers to ask. Omitted, it is discovered from `name`. */
  zone?: string;
  timeoutMs?: number;
  intervalMs?: number;
  log?: Logger;
  signal?: AbortSignal;
};

/**
 * Polls the zone's authoritative nameservers until EVERY expected value is visible on
 * EVERY one of them.
 *
 * Every server, not the first to answer: Let's Encrypt queries the authoritative set and
 * an unlucky pick against a server that has not caught up yet fails the whole order. Every
 * value, because a wildcard order needs both TXT records present simultaneously.
 */
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
      (await Promise.all(nameservers.map((ns) => dns.resolveAddresses(ns).catch(() => [] as string[])))).flat(),
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
          // NXDOMAIN and NODATA are the normal "not yet" answers, not failures.
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
    log.warn("TXT records did not propagate before the deadline", { name, zone, servers: addresses.length });
    return false;
  }
  log.info("TXT records visible on every authoritative nameserver", { name, zone, servers: addresses.length });
  return true;
}
