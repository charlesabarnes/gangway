import { describe, expect, test } from "bun:test";
import {
  CloudflareDnsProvider,
  type CloudflareOptions,
  type FetchLike,
} from "../../src/tls/dns/cloudflare.ts";
import { ManualDnsProvider } from "../../src/tls/dns/manual.ts";
import {
  waitForTxtPropagation,
  zoneCandidates,
  type DnsQueries,
} from "../../src/tls/dns/provider.ts";
import { Logger } from "../../src/logger.ts";
import { silentLogger } from "../helpers/logger.ts";

const BASE = "https://api.cloudflare.test/client/v4";
const CHALLENGE = "_acme-challenge.preview.example.com";

type Call = {
  method: string;
  path: string;
  query: string;
  auth: string | null;
  headers: Headers;
  body: any;
};
type CfRecord = {
  id: string;
  zoneId: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
};

/** An in-memory Cloudflare v4 API: enough of the shape to exercise every branch. */
function fakeCloudflare(o: { zones?: Record<string, string>; forcedStatuses?: number[] } = {}) {
  const zones = o.zones ?? { "example.com": "zone-example" };
  const forced = [...(o.forcedStatuses ?? [])];
  const records = new Map<string, CfRecord>();
  const calls: Call[] = [];
  let seq = 0;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const ok = (result: unknown) => json(200, { success: true, errors: [], messages: [], result });

  const fetchImpl: FetchLike = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rest = url.slice(BASE.length);
    const [path = "", query = ""] = rest.split("?");
    calls.push({
      method,
      path,
      query,
      auth: headers.get("authorization"),
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const force = forced.shift();
    if (force !== undefined) {
      return json(
        force,
        { success: false, errors: [{ code: 971, message: "rate limited" }], result: null },
        force === 429 ? { "retry-after": "0" } : {},
      );
    }

    if (method === "GET" && path === "/zones") {
      const wanted = new URLSearchParams(query).get("name") ?? "";
      const id = zones[wanted];
      return ok(id ? [{ id, name: wanted }] : []);
    }
    const byId = /^\/zones\/([^/]+)$/.exec(path);
    if (method === "GET" && byId) {
      const id = byId[1]!;
      const name = Object.keys(zones).find((n) => zones[n] === id);
      return name
        ? ok({ id, name })
        : json(404, {
            success: false,
            errors: [{ code: 1049, message: "not found" }],
            result: null,
          });
    }
    const create = /^\/zones\/([^/]+)\/dns_records$/.exec(path);
    if (method === "POST" && create) {
      const body = calls[calls.length - 1]!.body;
      const rec: CfRecord = {
        id: `rec-${++seq}`,
        zoneId: create[1]!,
        type: body.type,
        name: body.name,
        content: body.content,
        ttl: body.ttl,
      };
      records.set(rec.id, rec);
      return ok(rec);
    }
    const del = /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(path);
    if (method === "DELETE" && del) {
      const id = del[2]!;
      if (!records.delete(id)) {
        return json(404, {
          success: false,
          errors: [{ code: 81044, message: "Record does not exist." }],
          result: null,
        });
      }
      return ok({ id });
    }
    return json(404, {
      success: false,
      errors: [{ code: 7003, message: "no route" }],
      result: null,
    });
  };

  return { fetch: fetchImpl, calls, records, zones };
}

function provider(cf: ReturnType<typeof fakeCloudflare>, extra: Partial<CloudflareOptions> = {}) {
  return new CloudflareDnsProvider({
    apiToken: "cf-scoped-token",
    baseUrl: BASE,
    fetch: cf.fetch,
    log: silentLogger(),
    retry: { attempts: 4, baseMs: 1, maxMs: 2, random: () => 0 },
    ...extra,
  });
}

/** A stub authoritative view: what each nameserver IP answers for a TXT name. */
function fakeDns(
  answers: (ip: string, name: string, round: number) => string[] | Error,
): DnsQueries & { rounds: number } {
  const state = { rounds: 0 };
  return {
    get rounds() {
      return state.rounds;
    },
    async resolveNs(zone: string) {
      return [`ns1.${zone}`, `ns2.${zone}`];
    },
    async resolveAddresses(host: string) {
      return [host.startsWith("ns1.") ? "10.0.0.1" : "10.0.0.2"];
    },
    async resolveTxtFrom(ip: string, name: string) {
      if (ip === "10.0.0.1") state.rounds++; // one bump per poll round
      const a = answers(ip, name, state.rounds);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const zoneQueries = (cf: ReturnType<typeof fakeCloudflare>) =>
  cf.calls.filter((c) => c.path === "/zones").map((c) => new URLSearchParams(c.query).get("name"));

const wait = (dns: DnsQueries, values: string[], timeoutMs: number) =>
  waitForTxtPropagation(CHALLENGE, values, {
    dns,
    zone: "example.com",
    log: silentLogger(),
    timeoutMs,
    intervalMs: 5,
  });

describe("zone candidates", () => {
  test("walks labels right to left, most specific first, skipping underscore labels", () => {
    expect(zoneCandidates(CHALLENGE)).toEqual(["preview.example.com", "example.com"]);
    expect(zoneCandidates("example.com")).toEqual(["example.com"]);
    expect(zoneCandidates("a.b.c.example.com")).toEqual([
      "a.b.c.example.com",
      "b.c.example.com",
      "c.example.com",
      "example.com",
    ]);
  });
});

describe("CloudflareDnsProvider zone resolution", () => {
  test("finds example.com for a record under preview.example.com", async () => {
    const cf = fakeCloudflare();
    const { recordId } = await provider(cf).createTxt(CHALLENGE, "value-a");
    expect(zoneQueries(cf)).toEqual(["preview.example.com", "example.com"]);
    expect(cf.records.get(recordId)!.zoneId).toBe("zone-example");
  });

  test("prefers a delegated subdomain zone when the account has one", async () => {
    const cf = fakeCloudflare({
      zones: { "example.com": "zone-example", "preview.example.com": "zone-preview" },
    });
    const { recordId } = await provider(cf).createTxt(CHALLENGE, "value-a");
    expect(cf.records.get(recordId)!.zoneId).toBe("zone-preview");
    // Most specific candidate hits first: example.com is never asked for.
    expect(zoneQueries(cf)).toEqual(["preview.example.com"]);
  });

  test("caches the zone across calls for the same name", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf);
    await p.createTxt(CHALLENGE, "a");
    await p.createTxt(CHALLENGE, "b");
    expect(cf.calls.filter((c) => c.path === "/zones")).toHaveLength(2); // one lookup: 2 candidates
  });

  test("uses a pinned zone id instead of searching", async () => {
    const cf = fakeCloudflare();
    await provider(cf, { zoneId: "zone-example" }).createTxt(CHALLENGE, "a");
    expect(cf.calls[0]!.path).toBe("/zones/zone-example");
    expect(cf.calls.some((c) => c.path === "/zones")).toBe(false);
  });

  test("fails loudly when no zone covers the name", async () => {
    const cf = fakeCloudflare({ zones: {} });
    await expect(provider(cf).createTxt(CHALLENGE, "a")).rejects.toThrow(
      /no Cloudflare zone covers/,
    );
  });
});

describe("CloudflareDnsProvider auth", () => {
  test("sends a scoped bearer token and never a Global API Key", async () => {
    const cf = fakeCloudflare();
    await provider(cf).createTxt(CHALLENGE, "a");
    for (const c of cf.calls) {
      expect(c.auth).toBe("Bearer cf-scoped-token");
      expect(c.headers.get("x-auth-key")).toBeNull();
      expect(c.headers.get("x-auth-email")).toBeNull();
    }
  });

  test("a rejected token is a forbidden error naming the permission, not retried", async () => {
    const cf = fakeCloudflare({ forcedStatuses: [403] });
    await expect(provider(cf).createTxt(CHALLENGE, "a")).rejects.toThrow(/Zone:DNS:Edit/);
    expect(cf.calls).toHaveLength(1);
  });

  test("an empty token is rejected at construction", () => {
    expect(() => new CloudflareDnsProvider({ apiToken: "  " })).toThrow(/API token is required/);
  });
});

describe("CloudflareDnsProvider createTxt", () => {
  test("posts a TXT record with ttl 60 and returns the id Cloudflare assigned", async () => {
    const cf = fakeCloudflare();
    const { recordId } = await provider(cf).createTxt(CHALLENGE, "key-auth-value");

    const post = cf.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/zones/zone-example/dns_records");
    expect(post.body).toEqual({ type: "TXT", name: CHALLENGE, content: "key-auth-value", ttl: 60 });
    expect(recordId).toBe("rec-1");
    expect(cf.records.get("rec-1")).toMatchObject({
      name: CHALLENGE,
      content: "key-auth-value",
      ttl: 60,
    });
  });
});

describe("CloudflareDnsProvider removeTxt", () => {
  test("deletes by the stored id", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf);
    const { recordId } = await p.createTxt(CHALLENGE, "a");
    await p.removeTxt(recordId, CHALLENGE);
    expect(cf.records.size).toBe(0);
    expect(cf.calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/zones/zone-example/dns_records/${recordId}`,
    });
  });

  test("is idempotent: a 404 for an already-deleted record is success", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf);
    const { recordId } = await p.createTxt(CHALLENGE, "a");
    await p.removeTxt(recordId, CHALLENGE);
    await expect(p.removeTxt(recordId, CHALLENGE)).resolves.toBeUndefined();
    await expect(p.removeTxt("never-existed", CHALLENGE)).resolves.toBeUndefined();
  });
});

describe("CloudflareDnsProvider rate limits", () => {
  test("retries a 429 and succeeds", async () => {
    const cf = fakeCloudflare({ forcedStatuses: [429, 429] });
    const { recordId } = await provider(cf).createTxt(CHALLENGE, "a");
    expect(recordId).toBe("rec-1");
    // Two rejected attempts at the first zone query, then the normal sequence.
    expect(cf.calls.filter((c) => c.path === "/zones")).toHaveLength(4);
  });

  test("retries a 5xx as well", async () => {
    const cf = fakeCloudflare({ forcedStatuses: [502] });
    await expect(provider(cf).createTxt(CHALLENGE, "a")).resolves.toMatchObject({
      recordId: "rec-1",
    });
  });

  test("gives up after the attempt budget", async () => {
    const cf = fakeCloudflare({ forcedStatuses: [429, 429, 429, 429] });
    await expect(provider(cf).createTxt(CHALLENGE, "a")).rejects.toThrow(/429/);
  });
});

// A wildcard order puts two values at one name; an upserting createTxt fails half the time.
describe("wildcard order: two TXT records at one name", () => {
  test("adds both records at the same name and cleans up both", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf);

    // *.preview.example.com and preview.example.com both validate here, with different values.
    const a = await p.createTxt(CHALLENGE, "value-for-the-wildcard");
    const b = await p.createTxt(CHALLENGE, "value-for-the-bare-name");

    expect(a.recordId).not.toBe(b.recordId);
    const live = [...cf.records.values()];
    expect(live).toHaveLength(2);
    expect(live.every((r) => r.name === CHALLENGE)).toBe(true);
    expect(live.map((r) => r.content).sort()).toEqual([
      "value-for-the-bare-name",
      "value-for-the-wildcard",
    ]);
    // Nothing was updated or deleted on the way: two POSTs, no PUT/PATCH/DELETE.
    expect(cf.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(
      cf.calls.some((c) => c.method === "PUT" || c.method === "PATCH" || c.method === "DELETE"),
    ).toBe(false);

    await p.removeTxt(a.recordId, CHALLENGE);
    await p.removeTxt(b.recordId, CHALLENGE);
    expect(cf.records.size).toBe(0);
  });

  test("concurrent creates at one name share a single zone lookup", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf);
    const [a, b] = await Promise.all([p.createTxt(CHALLENGE, "v1"), p.createTxt(CHALLENGE, "v2")]);
    expect(new Set([a.recordId, b.recordId]).size).toBe(2);
    expect(cf.records.size).toBe(2);
    expect(cf.calls.filter((c) => c.path === "/zones")).toHaveLength(2); // 2 candidates, once
  });

  test("propagation needs both values, not just the first", async () => {
    const dns = fakeDns((ip) => (ip === "10.0.0.1" ? ["v1", "v2"] : ["v1"]));
    expect(await wait(dns, ["v1", "v2"], 60)).toBe(false);
  });
});

describe("waitForTxtPropagation", () => {
  test("keeps polling while only one of two nameservers has the value", async () => {
    // ns2 catches up on the 4th round; ns1 has it from the start.
    const dns = fakeDns((ip, _name, round) => {
      if (ip === "10.0.0.1") return ["v1"];
      return round >= 4 ? ["v1"] : [];
    });

    const started = Date.now();
    expect(await wait(dns, ["v1"], 2_000)).toBe(true);
    expect(dns.rounds).toBeGreaterThanOrEqual(4); // it did not stop at the first agreeing server
    expect(Date.now() - started).toBeGreaterThanOrEqual(10); // it actually waited between rounds
  });

  test("succeeds only once every authoritative server agrees", async () => {
    const dns = fakeDns((ip) => (ip === "10.0.0.1" ? ["v1"] : []));
    expect(await wait(dns, ["v1"], 40)).toBe(false);
  });

  test("returns true immediately when every server already has it", async () => {
    const dns = fakeDns(() => ["v1", "v2"]);
    expect(await wait(dns, ["v1", "v2"], 1_000)).toBe(true);
    expect(dns.rounds).toBe(1);
  });

  test("treats NXDOMAIN from a nameserver as 'not yet', not as a failure", async () => {
    const dns = fakeDns((ip, _n, round) => {
      if (ip === "10.0.0.2")
        return round >= 3
          ? ["v1"]
          : Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
      return ["v1"];
    });
    expect(await wait(dns, ["v1"], 2_000)).toBe(true);
  });

  test("throws when the zone has no reachable authoritative nameservers", async () => {
    const dns: DnsQueries = {
      async resolveNs() {
        return ["ns1.example.com"];
      },
      async resolveAddresses() {
        return [];
      },
      async resolveTxtFrom() {
        return [];
      },
    };
    await expect(
      waitForTxtPropagation(CHALLENGE, ["v1"], { dns, zone: "example.com", log: silentLogger() }),
    ).rejects.toThrow(/no authoritative nameserver addresses/);
  });

  test("the provider asks the zone's nameservers, not the challenge name's", async () => {
    const asked: string[] = [];
    const base = fakeDns(() => ["v1"]);
    const dns: DnsQueries = {
      resolveNs: (z) => {
        asked.push(z);
        return base.resolveNs(z);
      },
      resolveAddresses: (h) => base.resolveAddresses(h),
      resolveTxtFrom: (ip, n) => base.resolveTxtFrom(ip, n),
    };
    const cf = fakeCloudflare();
    const ok = await provider(cf, {
      dns,
      propagationTimeoutMs: 1_000,
      propagationIntervalMs: 5,
    }).waitForPropagation(CHALLENGE, ["v1"]);
    expect(ok).toBe(true);
    expect(asked).toEqual(["example.com"]);
  });
});

describe("ManualDnsProvider", () => {
  test("prints the record to add, hands back an id, and prints it again on cleanup", async () => {
    const lines: string[] = [];
    const p = new ManualDnsProvider({ log: new Logger("info", {}, (l) => lines.push(l)) });

    const a = await p.createTxt(CHALLENGE, "value-a");
    const b = await p.createTxt(CHALLENGE, "value-b");
    expect(a.recordId).not.toBe(b.recordId);
    expect(lines.join("\n")).toContain("value-a");
    expect(lines.join("\n")).toContain("in ADDITION");

    await p.removeTxt(a.recordId, CHALLENGE);
    expect(JSON.parse(lines.at(-1)!).msg).toContain("value-a");
    await expect(p.removeTxt(a.recordId, CHALLENGE)).resolves.toBeUndefined();
  });

  test("polls the authoritative nameservers like the Cloudflare provider does", async () => {
    const dns = fakeDns((ip, _n, round) => (ip === "10.0.0.1" ? ["v1"] : round >= 3 ? ["v1"] : []));
    const p = new ManualDnsProvider({ log: silentLogger(), dns, timeoutMs: 2_000, intervalMs: 5 });
    expect(await p.waitForPropagation(CHALLENGE, ["v1"])).toBe(true);
  });
});
