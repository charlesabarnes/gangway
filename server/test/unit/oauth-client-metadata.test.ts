import { describe, expect, test } from "bun:test";
import {
  checkClientIdUrl,
  ClientMetadataError,
  ClientMetadataStore,
  fetchDocument,
  isPublicAddress,
  parseDocument,
  redirectAllowed,
  type Fetched,
} from "../../src/oauth/client-metadata.ts";
import { CLAUDE, CONNECTOR } from "../helpers/oauth.ts";

const ok = (doc: unknown, over: Partial<Fetched> = {}): Fetched => ({
  status: 200,
  contentType: "application/json",
  cacheControl: "",
  body: JSON.stringify(doc),
  ...over,
});

describe("client metadata documents: what may be fetched", () => {
  test.each([
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.17.0.1", false],
    ["192.168.1.1", false],
    ["100.103.231.69", false],
    ["169.254.169.254", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["fe80::1", false],
    ["fd00::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:10.0.0.1", false],
    ["not-an-ip", false],
    ["160.79.104.10", true],
    ["8.8.8.8", true],
    ["2606:4700::1111", true],
    ["::ffff:8.8.8.8", true],
  ])("%s public: %p", (ip, ok) => expect(isPublicAddress(ip)).toBe(ok));

  test.each([
    ["http://claude.ai/x", "https"],
    ["https://claude.ai:8443/x", "default https port"],
    ["https://u:p@claude.ai/x", "credentials"],
    ["https://claude.ai/x#frag", "fragment"],
    ["https://claude.ai/", "path"],
    ["https://127.0.0.1/x", "not an address"],
    ["https://CLAUDE.ai/x", "normalized"],
    ["nope", "not a URL"],
  ])("client_id %s is refused (%s)", (url, why) =>
    expect(() => checkClientIdUrl(url)).toThrow(why),
  );

  test("a name that resolves to loopback is refused at connect time", async () => {
    await expect(fetchDocument(new URL("https://localhost/client.json"))).rejects.toThrow(
      "non-public address",
    );
  });
});

describe("client metadata documents: what they must say", () => {
  test("a document that names itself and lists redirects is read", () => {
    expect(
      parseDocument(
        CLAUDE,
        ok({
          client_id: CLAUDE,
          client_name: "Claude Code",
          redirect_uris: ["http://localhost/callback"],
        }),
      ),
    ).toEqual({
      clientId: CLAUDE,
      clientName: "Claude Code",
      redirectUris: ["http://localhost/callback"],
    });
  });

  test.each([
    [
      "another client_id",
      ok({ client_id: "https://evil.example/x", redirect_uris: ["https://x/cb"] }),
      "does not match",
    ],
    ["no redirects", ok({ client_id: CLAUDE, redirect_uris: [] }), "redirect_uris"],
    [
      "a confidential client",
      ok({
        client_id: CLAUDE,
        redirect_uris: ["https://x/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
      "public clients",
    ],
    ["a 404", ok({}, { status: 404 }), "404"],
    ["HTML", ok({}, { contentType: "text/html" }), "not JSON"],
  ])("refuses %s", (_what, fetched, why) => {
    expect(() => parseDocument(CLAUDE, fetched)).toThrow(why);
  });

  test("accepts a private_key_jwt client that also supports none", () => {
    const doc = parseDocument(
      CLAUDE,
      ok({
        client_id: CLAUDE,
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      }),
    );
    expect(doc.redirectUris).toEqual(["https://chatgpt.com/connector_platform_oauth_redirect"]);
  });

  test("the name is cleaned of bidi and control characters, or falls back to the host", () => {
    expect(
      parseDocument(
        CLAUDE,
        ok({
          client_id: CLAUDE,
          client_name: "Cla\u202eude\u0000",
          redirect_uris: ["https://x/cb"],
        }),
      ).clientName,
    ).toBe("Claude");
    expect(
      parseDocument(CLAUDE, ok({ client_id: CLAUDE, redirect_uris: ["https://x/cb"] })).clientName,
    ).toBe("claude.ai");
  });

  test("cached per Cache-Control within 5 min .. 24 h; a failure is not cached", async () => {
    let t = 0,
      calls = 0,
      fail = true;
    const store = new ClientMetadataStore({
      now: () => t,
      fetch: async () => {
        calls++;
        if (fail) throw new Error("boom");
        return ok(
          { client_id: CLAUDE, redirect_uris: ["https://x/cb"] },
          { cacheControl: "max-age=1" },
        );
      },
    });
    await expect(store.get(CLAUDE)).rejects.toBeInstanceOf(ClientMetadataError);
    fail = false;
    await store.get(CLAUDE);
    await store.get(CLAUDE);
    expect(calls).toBe(2);
    t += 5 * 60_000 + 1;
    await store.get(CLAUDE);
    expect(calls).toBe(3);
  });

  const registered = ["http://localhost/callback", "http://127.0.0.1/callback", CONNECTOR];
  test.each([
    [CONNECTOR, true],
    ["http://localhost:53682/callback", true],
    ["http://127.0.0.1:1234/callback", true],
    ["http://localhost:53682/other", false],
    ["https://claude.ai/api/mcp/auth_callback/", false],
    ["https://evil.example/cb", false],
    ["http://localhost.evil.example/callback", false],
  ])("redirect %s is allowed: %p; loopback ignores the port", (uri, allowed) => {
    expect(redirectAllowed(uri, registered)).toBe(allowed);
  });
});
