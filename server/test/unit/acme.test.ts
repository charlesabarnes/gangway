/**
 * The order of operations in tls/acme.ts, against a fake CA that signs with the dev CA.
 * This proves the sequencing; scripts/acme-pebble-check.ts proves it against a real
 * ACME server. A passing fake alone proves nothing about the real protocol.
 */
import { describe, expect, test } from "bun:test";
import { CertificatesRepo } from "../../src/db/repos/index.ts";
import { MemorySettingsStore } from "../../src/settings.ts";
import { AcmeProvider, type AcmeApi } from "../../src/tls/acme.ts";
import type { DnsProvider } from "../../src/tls/dns/provider.ts";
import { createCa, issueLeaf } from "../../src/tls/selfsigned.ts";
import { silentLogger } from "../helpers/logger.ts";
import { tempDb } from "../helpers/db.ts";

const DOMAINS = ["*.preview.test", "preview.test"];
const DIRECTORY = "https://ca.test/directory";
const DAY = 86_400_000;

async function setup(o: { propagates?: boolean; failAt?: string; days?: number } = {}) {
  const { db } = tempDb();
  const certs = new CertificatesRepo(db);
  const store = new MemorySettingsStore();
  const ca = await createCa("Fake ACME CA");
  /** Everything that happened, in order. The assertions are about this. */
  const log: string[] = [];
  const connects: { accountUrl?: string | undefined }[] = [];
  let txt = 0;

  const dns: DnsProvider = {
    async createTxt(name, value) {
      log.push(`txt+ ${name}=${value}`);
      return { recordId: `r${++txt}` };
    },
    async removeTxt(recordId) {
      log.push(`txt- ${recordId}`);
    },
    async waitForPropagation(name, values) {
      log.push(`propagated? ${name} [${[...values].sort().join(",")}]`);
      return o.propagates ?? true;
    },
  };
  const step = (name: string) => {
    log.push(name);
    if (o.failAt === name) throw new Error(`${name} failed`);
  };
  const connect = (c: { accountUrl?: string }) => {
    connects.push({ accountUrl: c.accountUrl });
    const api = {
      async createAccount() {
        step("createAccount");
        return {};
      },
      getAccountUrl: () => "https://ca.test/acct/1",
      async createOrder(data: { identifiers: { value: string }[] }) {
        step("createOrder");
        return { identifiers: data.identifiers };
      },
      async getAuthorizations(order: { identifiers: { value: string }[] }) {
        return order.identifiers.map((identifier, i) => ({
          identifier,
          status: "pending",
          wildcard: identifier.value.startsWith("*."),
          challenges: [
            { type: "http-01", token: `h${i}` },
            { type: "dns-01", token: `d${i}` },
          ],
        }));
      },
      async getChallengeKeyAuthorization(c: { token: string }) {
        return `ka-${c.token}`;
      },
      async completeChallenge(c: { token: string }) {
        step(`complete ${c.token}`);
        return c;
      },
      async waitForValidStatus(c: { token: string }) {
        step(`valid ${c.token}`);
        return c;
      },
      async finalizeOrder(order: unknown) {
        step("finalize");
        return order;
      },
      async getCertificate() {
        step("getCertificate");
        return (await issueLeaf(ca, DOMAINS, o.days ?? 90)).cert;
      },
    };
    return api as unknown as AcmeApi;
  };

  const clock = { now: Date.now() };
  const make = (directoryUrl = DIRECTORY) =>
    new AcmeProvider({
      directoryUrl,
      email: "ops@example.com",
      dns,
      certs,
      store,
      connect,
      logger: silentLogger(),
      now: () => clock.now,
    });
  return { provider: make(), make, certs, store, log, connects, clock };
}

describe("AcmeProvider.issue", () => {
  test("BOTH TXT records exist, and are seen to have propagated TOGETHER, before the CA is asked to validate either", async () => {
    const s = await setup();
    const bundle = await s.provider.issue(DOMAINS);
    expect(s.log).toEqual([
      "createAccount",
      "createOrder",
      "txt+ _acme-challenge.preview.test=ka-d0",
      "txt+ _acme-challenge.preview.test=ka-d1",
      "propagated? _acme-challenge.preview.test [ka-d0,ka-d1]",
      "complete d0",
      "valid d0",
      "complete d1",
      "valid d1",
      "finalize",
      "getCertificate",
      "txt- r1",
      "txt- r2",
    ]);
    const m = bundle.materials[0]!;
    expect(m.serverName).toBe("*.preview.test");
    expect(m.cert.match(/BEGIN CERTIFICATE/g)!.length).toBe(2); // leaf + chain
    expect(m.cert).not.toMatch(/-----END CERTIFICATE----------BEGIN/);
    expect(m.key).toContain("PRIVATE KEY");
    expect(m.notAfter!.getTime()).toBeGreaterThan(Date.now() + 80 * DAY);
  });

  test("stored before it is returned, with the directory that issued it", async () => {
    const s = await setup();
    await s.provider.issue(DOMAINS);
    expect(s.certs.get("*.preview.test")).toMatchObject({
      source: DIRECTORY,
      issuer: "Fake ACME CA",
    });
    expect(s.certs.get("*.preview.test")!.chainPem).toContain("BEGIN CERTIFICATE");
  });

  test("no propagation: the CA is never asked, and the records are still removed", async () => {
    const s = await setup({ propagates: false });
    await expect(s.provider.issue(DOMAINS)).rejects.toThrow("did not propagate");
    expect(s.log.some((l) => l.startsWith("complete"))).toBe(false);
    expect(s.log.slice(-2)).toEqual(["txt- r1", "txt- r2"]);
    expect(s.certs.get("*.preview.test")).toBeUndefined();
  });

  test("a failed validation still cleans up its records", async () => {
    const s = await setup({ failAt: "valid d1" });
    await expect(s.provider.issue(DOMAINS)).rejects.toThrow("valid d1 failed");
    expect(s.log.slice(-2)).toEqual(["txt- r1", "txt- r2"]);
  });

  test("the account is created once and reused -- a new account per order is its own rate limit", async () => {
    const s = await setup();
    await s.provider.issue(DOMAINS);
    await s.make().issue(DOMAINS);
    expect(s.log.filter((l) => l === "createAccount").length).toBe(1);
    expect(s.connects.map((c) => c.accountUrl)).toEqual([undefined, "https://ca.test/acct/1"]);
    // ...per directory: staging and production are different CAs.
    await s.make("https://other.test/directory").issue(DOMAINS);
    expect(s.log.filter((l) => l === "createAccount").length).toBe(2);
  });

  test("an aborted signal stops before anything is written to DNS", async () => {
    const s = await setup();
    await expect(s.provider.issue(DOMAINS, AbortSignal.abort())).rejects.toThrow();
    expect(s.log.some((l) => l.startsWith("txt+"))).toBe(false);
  });
});

describe("AcmeProvider.load / renewIfDue", () => {
  test("a fresh stored certificate is served from the database with no network at all", async () => {
    const s = await setup();
    await s.provider.issue(DOMAINS);
    s.log.length = 0;
    const again = s.make();
    expect(again.load(DOMAINS)!.materials[0]!.cert).toContain("BEGIN CERTIFICATE");
    expect(await again.renewIfDue(DOMAINS)).toBeNull();
    expect((await again.ensure(DOMAINS)).materials.length).toBe(1);
    expect(s.log).toEqual([]);
  });

  test("inside the 30-day window it is still SERVED, and renewed", async () => {
    const s = await setup();
    await s.provider.issue(DOMAINS);
    s.clock.now += 65 * DAY;
    expect(s.provider.load(DOMAINS)).not.toBeNull();
    expect(await s.provider.renewIfDue(DOMAINS)).not.toBeNull();
  });

  test("a short-lived (6-day) certificate is NOT due the moment it is issued; it is due in its last third", async () => {
    const s = await setup({ days: 6 });
    const bundle = await s.provider.issue(DOMAINS);
    expect(s.provider.isDue(bundle)).toBe(false);
    expect(await s.provider.renewIfDue(DOMAINS)).toBeNull();
    s.clock.now += 3.9 * DAY;
    expect(s.provider.isDue(bundle)).toBe(false);
    s.clock.now += 0.2 * DAY;
    expect(s.provider.isDue(bundle)).toBe(true);
  });

  test("expired, from another directory, or missing a name: not usable", async () => {
    const s = await setup();
    await s.provider.issue(DOMAINS);
    expect(s.make("https://production.test/directory").load(DOMAINS)).toBeNull(); // staging -> production
    expect(s.provider.load(["*.preview.test", "preview.test", "extra.test"])).toBeNull();
    s.clock.now += 91 * DAY;
    expect(s.provider.load(DOMAINS)).toBeNull();
  });

  test("garbage in the certificates table is 'nothing stored', not a crash at boot", async () => {
    const s = await setup();
    s.certs.put({
      domain: "*.preview.test",
      certPem: "not a pem",
      keyPem: "k",
      chainPem: null,
      issuer: null,
      source: DIRECTORY,
      notBefore: new Date(),
      notAfter: new Date(Date.now() + DAY),
    });
    expect(s.provider.load(DOMAINS)).toBeNull();
  });
});
