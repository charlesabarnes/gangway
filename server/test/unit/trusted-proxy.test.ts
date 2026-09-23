import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { clientIpResolver, parseTrustedProxies } from "../../src/net/trusted-proxy.ts";

const NPM = ["172.17.0.0/16"];

describe("clientIpResolver", () => {
  test("with no trusted proxies the socket peer is the visitor, whatever the header says", () => {
    const ip = clientIpResolver([]);
    expect(ip("203.0.113.9", "1.2.3.4")).toBe("203.0.113.9");
    expect(ip("172.17.0.2", "1.2.3.4")).toBe("172.17.0.2");
  });

  test("behind a trusted proxy the address the proxy saw is the visitor", () => {
    const ip = clientIpResolver(NPM);
    expect(ip("172.17.0.2", "198.51.100.7")).toBe("198.51.100.7");
    // A dual-stack listener reports the proxy as an IPv4-mapped IPv6 address.
    expect(ip("::ffff:172.17.0.2", "198.51.100.7")).toBe("198.51.100.7");
    expect(ip("172.17.0.2", "2001:db8::1")).toBe("2001:db8::1");
  });

  test("ignores the header from an untrusted peer", () => {
    expect(clientIpResolver(NPM)("203.0.113.9", "10.0.0.1")).toBe("203.0.113.9");
  });

  test("reads the header right to left and stops at the first untrusted hop", () => {
    const ip = clientIpResolver(NPM);
    expect(ip("172.17.0.2", "10.0.0.1, 198.51.100.7")).toBe("198.51.100.7");
    expect(
      clientIpResolver([...NPM, "192.0.2.0/24"])("172.17.0.2", "6.6.6.6, 198.51.100.7, 192.0.2.10"),
    ).toBe("198.51.100.7");
  });

  test("falls back to the peer when the header has nothing usable", () => {
    const ip = clientIpResolver(NPM);
    expect(ip("172.17.0.2", null)).toBe("172.17.0.2");
    expect(ip("172.17.0.2", "")).toBe("172.17.0.2");
    expect(ip("172.17.0.2", "172.17.0.3")).toBe("172.17.0.2"); // only trusted hops
    expect(ip("172.17.0.2", "198.51.100.7, <script>")).toBe("172.17.0.2"); // junk ends the walk
    expect(ip("", "198.51.100.7")).toBe("");
  });
});

describe("parseTrustedProxies / config", () => {
  test("accepts bare addresses and CIDRs in both families", () => {
    const l = parseTrustedProxies(["172.17.0.1", "10.0.0.0/8", "fd00::/8"]);
    expect([
      l.check("172.17.0.1"),
      l.check("172.17.0.2"),
      l.check("10.9.9.9"),
      l.check("fd12::1", "ipv6"),
    ]).toEqual([true, false, true, true]);
  });

  test.each(["npm", "172.17.0.0/33", "172.17.0.0/x", "fd00::/129", ""])(
    "refuses %p rather than trusting nobody",
    (bad) => {
      expect(() => parseTrustedProxies([bad])).toThrow("trusted proxy");
    },
  );

  test("GANGWAY_TRUSTED_PROXIES is a comma-separated list; unset is empty", () => {
    expect(loadConfig({}, {}).trustedProxies).toEqual([]);
    expect(
      loadConfig({ GANGWAY_TRUSTED_PROXIES: "172.17.0.0/16, 127.0.0.1" }, {}).trustedProxies,
    ).toEqual(["172.17.0.0/16", "127.0.0.1"]);
    expect(loadConfig({}, { trustedProxies: ["10.0.0.0/8"] }).trustedProxies).toEqual([
      "10.0.0.0/8",
    ]);
  });
});
