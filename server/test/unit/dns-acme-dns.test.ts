import { describe, expect, test } from "bun:test";
import { AcmeDnsProvider, type AcmeDnsOptions } from "../../src/tls/dns/acme-dns.ts";
import type { DnsQueries } from "../../src/tls/dns/provider.ts";
import { dnsProvider } from "../../src/boot/tls.ts";
import { CloudflareDnsProvider, type FetchLike } from "../../src/tls/dns/cloudflare.ts";
import { ManualDnsProvider } from "../../src/tls/dns/manual.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { silentLogger } from "../helpers/logger.ts";

const API = "https://auth.acme-dns.test";
const SUB = "d420c923-bbd7-4056-ab64-c3ca54c9b3cf";
const TARGET = `${SUB}.auth.acme-dns.test`;
const CHALLENGE = "_acme-challenge.preview.example.com";
const PASSWORD = "test-password-not-real";

type Call = { url: string; headers: Headers; body: any; redirect: RequestRedirect | undefined };

/** An acme-dns /update endpoint that keeps the two latest values, as the real one does. */
function fakeAcmeDns(o: { statuses?: number[] } = {}) {
  const statuses = [...(o.statuses ?? [])];
  const calls: Call[] = [];
  const values: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    calls.push({ url, headers, body, redirect: init?.redirect });
    const status = statuses.shift() ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "nope" }), { status });
    }
    values.push(body.txt);
    values.splice(0, Math.max(0, values.length - 2));
    return new Response(JSON.stringify({ txt: body.txt }), { status: 200 });
  };
  return { fetch: fetchImpl, calls, values };
}

/** Resolves CNAMEs from a table; the target's zone has one nameserver that answers from `txt`. */
function fakeDns(
  cnames: Record<string, string>,
  txt: () => string[],
): DnsQueries & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async resolveCname(host) {
      const next = cnames[host];
      return next === undefined ? [] : [next];
    },
    async resolveNs(zone) {
      if (zone === "auth.acme-dns.test") {
        return ["ns.auth.acme-dns.test"];
      }
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    },
    async resolveAddresses() {
      return ["10.0.0.9"];
    },
    async resolveTxtFrom(_ip, name) {
      asked.push(name);
      return name === TARGET ? txt() : [];
    },
  };
}

function provider(
  api: ReturnType<typeof fakeAcmeDns>,
  dns: DnsQueries,
  extra: Partial<AcmeDnsOptions> = {},
) {
  return new AcmeDnsProvider({
    url: `${API}/`,
    username: "eabcdb41-d89f-4580-826f-3e62e9755ef2",
    password: PASSWORD,
    subdomain: SUB,
    fetch: api.fetch,
    dns,
    log: silentLogger(),
    retry: { attempts: 3, baseMs: 1, maxMs: 2, random: () => 0 },
    propagationTimeoutMs: 200,
    propagationIntervalMs: 5,
    ...extra,
  });
}

const delegated = (api: ReturnType<typeof fakeAcmeDns>) =>
  fakeDns({ [CHALLENGE]: `${TARGET}.` }, () => api.values);

describe("AcmeDnsProvider createTxt", () => {
  test("posts the value for its subdomain with the account's headers", async () => {
    const api = fakeAcmeDns();
    const { recordId } = await provider(api, delegated(api)).createTxt(CHALLENGE, "value-1");
    expect(recordId).toStartWith("acme-dns-");
    expect(api.calls).toHaveLength(1);
    const call = api.calls[0]!;
    expect(call.url).toBe(`${API}/update`);
    expect(call.headers.get("x-api-user")).toBe("eabcdb41-d89f-4580-826f-3e62e9755ef2");
    expect(call.headers.get("x-api-key")).toBe(PASSWORD);
    expect(call.body).toEqual({ subdomain: SUB, txt: "value-1" });
  });

  test("a wildcard order's two values both stay", async () => {
    const api = fakeAcmeDns();
    const p = provider(api, delegated(api));
    await p.createTxt(CHALLENGE, "apex");
    await p.createTxt(CHALLENGE, "wildcard");
    expect(api.values).toEqual(["apex", "wildcard"]);
    expect(await p.waitForPropagation(CHALLENGE, ["apex", "wildcard"])).toBe(true);
  });

  test("follows a chain of CNAMEs, as a claimed domain's delegation does", async () => {
    const api = fakeAcmeDns();
    const claim = "_acme-challenge.www.client.test";
    const dns = fakeDns(
      { [claim]: "c1.acme.preview.example.com", "c1.acme.preview.example.com": TARGET },
      () => api.values,
    );
    const p = provider(api, dns);
    await p.createTxt(claim, "v");
    expect(await p.waitForPropagation(claim, ["v"])).toBe(true);
    expect(dns.asked).toContain(TARGET);
  });

  test("a name with no CNAME to the subdomain is refused before anything is sent", async () => {
    const api = fakeAcmeDns();
    const p = provider(
      api,
      fakeDns({}, () => []),
    );
    const err = await p.createTxt(CHALLENGE, "v").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`add a CNAME from ${CHALLENGE} to ${SUB}.`);
    expect(api.calls).toHaveLength(0);
  });

  test("retries a 5xx and a 429, then succeeds", async () => {
    const api = fakeAcmeDns({ statuses: [500, 429] });
    await provider(api, delegated(api)).createTxt(CHALLENGE, "v");
    expect(api.calls).toHaveLength(3);
    expect(api.values).toEqual(["v"]);
  });

  test("a rejected account is not retried and the error never carries the password", async () => {
    const api = fakeAcmeDns({ statuses: [401] });
    const err = await provider(api, delegated(api))
      .createTxt(CHALLENGE, "v")
      .catch((e: unknown) => e);
    expect(api.calls).toHaveLength(1);
    expect((err as Error).message).toContain("GANGWAY_ACME_DNS_PASSWORD");
    expect(JSON.stringify({ m: (err as Error).message, d: (err as any).detail })).not.toContain(
      PASSWORD,
    );
  });

  test("never follows a redirect with the account's key", async () => {
    const api = fakeAcmeDns({ statuses: [302] });
    await expect(provider(api, delegated(api)).createTxt(CHALLENGE, "v")).rejects.toThrow(/302/);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.redirect).toBe("manual");
  });

  test("a 400 is permanent", async () => {
    const api = fakeAcmeDns({ statuses: [400] });
    await expect(provider(api, delegated(api)).createTxt(CHALLENGE, "v")).rejects.toThrow(
      /acme-dns POST \/update failed: 400/,
    );
    expect(api.calls).toHaveLength(1);
  });

  test("every field is required", () => {
    const api = fakeAcmeDns();
    expect(() => provider(api, delegated(api), { subdomain: " " })).toThrow(/subdomain/);
    expect(() => provider(api, delegated(api), { password: "" })).toThrow(/password/);
  });
});

describe("AcmeDnsProvider propagation", () => {
  test("waits at the CNAME's target on the target zone's nameservers", async () => {
    const api = fakeAcmeDns();
    const dns = delegated(api);
    const p = provider(api, dns);
    expect(await p.waitForPropagation(CHALLENGE, ["missing"])).toBe(false);
    expect(dns.asked.every((n) => n === TARGET)).toBe(true);
  });

  test("removeTxt is a no-op: acme-dns has no delete", async () => {
    const api = fakeAcmeDns();
    await provider(api, delegated(api)).removeTxt();
    expect(api.calls).toHaveLength(0);
  });
});

describe("choosing the DNS-01 provider", () => {
  const settingsWith = (overrides: Record<string, string>) =>
    new Settings(overrides, new MemorySettingsStore());

  test("acme-dns when its URL is set, even beside a Cloudflare token", () => {
    const settings = settingsWith({
      [SETTINGS.acmeDnsUrl.key]: API,
      [SETTINGS.acmeDnsUsername.key]: "u",
      [SETTINGS.acmeDnsPassword.key]: "p",
      [SETTINGS.acmeDnsSubdomain.key]: SUB,
      [SETTINGS.cloudflareApiToken.key]: "cf",
    });
    expect(dnsProvider(settings, silentLogger())).toBeInstanceOf(AcmeDnsProvider);
  });

  test("the acme-dns URL must be https, since every order sends the account's key", () => {
    const settings = settingsWith({ [SETTINGS.acmeDnsUrl.key]: "http://auth.acme-dns.test" });
    expect(() => settings.get(SETTINGS.acmeDnsUrl)).toThrow(/acme\.acmeDns\.url/);
    expect(settingsWith({ [SETTINGS.acmeDnsUrl.key]: API }).get(SETTINGS.acmeDnsUrl)).toBe(API);
  });

  test("Cloudflare with a token, else manual", () => {
    expect(
      dnsProvider(settingsWith({ [SETTINGS.cloudflareApiToken.key]: "cf" }), silentLogger()),
    ).toBeInstanceOf(CloudflareDnsProvider);
    expect(dnsProvider(settingsWith({}), silentLogger())).toBeInstanceOf(ManualDnsProvider);
  });
});
