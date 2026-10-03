import { describe, expect, test } from "bun:test";
import { dispatch, type DispatchDeps } from "../../src/net/dispatch.ts";
import { keepFromSharedCaches, privateCacheControl } from "../../src/net/headers.ts";
import { DEFAULT_LIMITS } from "../../src/net/limits.ts";
import type { RouteEntry } from "../../src/routing/table.ts";
import { entry, HOST, makeGate, passwords } from "../helpers/preview-password.ts";

describe("privateCacheControl", () => {
  test("public becomes private, and a year in the browser stays", () => {
    expect(privateCacheControl("public, max-age=31536000, immutable")).toBe(
      "private, max-age=31536000, immutable",
    );
  });

  test("nothing at all becomes private, so a CDN cannot apply its own default", () => {
    expect(privateCacheControl(null)).toBe("private");
    expect(privateCacheControl("")).toBe("private");
  });

  test("s-maxage and a field-only private go; no-store and private stay as they are", () => {
    expect(privateCacheControl("max-age=60, s-maxage=3600")).toBe("private, max-age=60");
    expect(privateCacheControl('private="set-cookie", max-age=60')).toBe("private, max-age=60");
    expect(privateCacheControl("no-store")).toBe("no-store");
    expect(privateCacheControl("private, no-cache")).toBe("private, no-cache");
    expect(privateCacheControl("Public, S-MaxAge=10")).toBe("private");
  });
});

describe("keepFromSharedCaches", () => {
  test("drops the CDN-only headers and keeps everything else", async () => {
    const headers = new Headers({
      "cache-control": "public, max-age=600",
      "cdn-cache-control": "max-age=86400",
      "cloudflare-cdn-cache-control": "max-age=86400",
      "surrogate-control": "max-age=86400",
      "content-type": "text/css",
    });
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const res = keepFromSharedCaches(new Response("body{}", { status: 201, headers }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, max-age=600");
    expect(res.headers.get("cdn-cache-control")).toBeNull();
    expect(res.headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(res.headers.get("surrogate-control")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/css");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(await res.text()).toBe("body{}");
  });
});

describe("PreviewGate.restricts", () => {
  test("private, signed-in-only and password previews are restricted, open ones not", async () => {
    const own = { mode: "own", ...(await passwords.hash("correct horse")) } as const;
    const { gate } = makeGate();
    expect(gate.restricts(entry({ mode: "none" }))).toBe(false);
    expect(gate.restricts(entry({ mode: "inherit" }))).toBe(false);
    expect(gate.restricts(entry({ mode: "none" }, { visibility: "unlisted" }))).toBe(false);
    expect(gate.restricts(entry({ mode: "none" }, { visibility: "private" }))).toBe(true);
    expect(gate.restricts(entry({ mode: "none" }, { passwordLogin: "only" }))).toBe(true);
    expect(gate.restricts(entry(own))).toBe(true);
  });

  test("a preview that inherits the shared password is restricted while one is set", async () => {
    const shared = await passwords.hash("shared secret");
    expect(makeGate({ shared }).gate.restricts(entry({ mode: "inherit" }))).toBe(true);
  });
});

describe("dispatch keeps a gated preview's answers out of shared caches", () => {
  const immutable = "public, max-age=31536000, immutable";

  function deps(e: RouteEntry, restricted: boolean): DispatchDeps {
    return {
      baseDomain: () => "preview.example.dev",
      table: { lookup: (h: string) => (h === e.hostname ? e : undefined) } as never,
      upstream: {
        name: "stub",
        fetch: async () =>
          new Response("proxied", {
            headers: { "cache-control": immutable, "cdn-cache-control": "max-age=60" },
          }),
      },
      site: async () => new Response("served", { headers: { "cache-control": immutable } }),
      limits: DEFAULT_LIMITS,
      surfaceEnabled: () => true,
      handlers: {},
      clientIpFor: () => "10.0.0.1",
      restricted: () => restricted,
    };
  }
  const get = (d: DispatchDeps) =>
    dispatch(
      new Request(`https://${HOST}/assets/index-BX7k2a9Q.js`, { headers: { host: HOST } }),
      d,
    );

  test("a gated static preview's hashed files are private", async () => {
    const res = await get(deps(entry({ mode: "none" }, { site: true }), true));
    expect(await res.text()).toBe("served");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  test("a gated container preview's answers are private too, whatever the app said", async () => {
    const res = await get(deps(entry({ mode: "none" }), true));
    expect(await res.text()).toBe("proxied");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("cdn-cache-control")).toBeNull();
  });

  test("an open preview's headers are left alone", async () => {
    const site = await get(deps(entry({ mode: "none" }, { site: true }), false));
    expect(site.headers.get("cache-control")).toBe(immutable);
    const proxied = await get(deps(entry({ mode: "none" }), false));
    expect(proxied.headers.get("cdn-cache-control")).toBe("max-age=60");
  });
});
