import { describe, expect, test } from "bun:test";
import { TLS_ASK_PATH, tlsAsk } from "../../src/net/tls-ask.ts";

const ask = tlsAsk({
  trustedProxies: ["172.17.0.0/16"],
  answers: (host) => host === "shop.preview.test" || host === "www.client.com",
});
const req = (domain: string, path = TLS_ASK_PATH) =>
  new Request(`http://gw.test${path}?domain=${encodeURIComponent(domain)}`);

describe("the proxy's certificate ask", () => {
  test("yes for a name gangway answers, from loopback or a trusted proxy", () => {
    expect(ask(req("shop.preview.test"), "127.0.0.1")?.status).toBe(200);
    expect(ask(req("WWW.Client.com."), "::ffff:172.17.0.3")?.status).toBe(200);
  });

  test("no for anything else, and nothing for anyone else", () => {
    expect(ask(req("random.preview.test"), "127.0.0.1")?.status).toBe(404);
    expect(ask(req("shop.preview.test"), "203.0.113.9")?.status).toBe(404);
    expect(ask(req(""), "127.0.0.1")?.status).toBe(404);
  });

  test("other paths are not its business", () => {
    expect(ask(req("shop.preview.test", "/"), "127.0.0.1")).toBeNull();
  });
});
