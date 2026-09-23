import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { GATE_COOKIE, PreviewGate, loadOrCreateGateKey, safePath, stripGangwayCookies } from "../../src/net/gate.ts";
import { buildUpstreamHeaders } from "../../src/net/headers.ts";
import type { RouteEntry } from "../../src/routing/table.ts";

const APP = "https://app.preview.example.dev";
const entry = (over: Partial<RouteEntry> = {}): RouteEntry => ({
  hostname: "shop.preview.example.dev", previewId: "01SHOP0000000000000000000A", hostId: "local", project: "gw-shop", service: "web",
  containerPort: 80, upstreamHost: "127.0.0.1", upstreamPort: 31000, primary: true, visibility: "private", password: { mode: "inherit" }, passwordLogin: "inherit", state: "awake",
  inflight: 0, bytesInFlight: 0, lastSeenAt: 0, ...over,
});

function make(key = randomBytes(32)) {
  let now = 1_700_000_000_000;
  const gate = new PreviewGate({ key, appOrigin: () => APP, now: () => now });
  const get = (e: RouteEntry, path: string, headers: Record<string, string> = {}, method = "GET") =>
    gate.check(e, new Request(`https://${e.hostname}${path}`, { method, headers }));
  /** Walk the handshake the way a browser would and hand back the cookie it would now hold. */
  const signIn = (e: RouteEntry, to = "/") => {
    const res = get(e, `/__gangway/auth?ticket=${encodeURIComponent(gate.issueTicket(e))}&to=${encodeURIComponent(to)}`)!;
    return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  return { gate, get, signIn, tick: (ms: number) => { now += ms; } };
}

describe("public and unlisted previews", () => {
  test("pass straight through", () => {
    const t = make();
    expect(t.get(entry({ visibility: "public" }), "/")).toBeNull();
    expect(t.get(entry({ visibility: "unlisted" }), "/api/things?x=1", {}, "POST")).toBeNull();
  });

  test("/__gangway/* is never forwarded, for ANY preview: a preview must not be able to serve a fake of it", () => {
    const t = make();
    for (const visibility of ["public", "unlisted", "private"] as const) {
      for (const path of ["/__gangway", "/__gangway/", "/__gangway/auth-but-not", "/__gangway/anything/else"]) {
        expect(t.get(entry({ visibility }), path)?.status).toBe(404);
      }
    }
    expect(t.get(entry({ visibility: "public" }), "/__gangway/auth?ticket=x")?.status).toBe(404);
  });
});

describe("a private preview, with no gate cookie", () => {
  test("a page load is sent to app's gate with the hostname and the path to come back to", () => {
    const t = make();
    const res = t.get(entry(), "/orders/42?tab=items", { "sec-fetch-mode": "navigate" })!;
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe(APP);
    expect(to.pathname).toBe("/v1/auth/gate");
    expect(to.searchParams.get("host")).toBe("shop.preview.example.dev");
    expect(to.searchParams.get("to")).toBe("/orders/42?tab=items");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("curl (no Sec-Fetch-Mode) is treated as a page load too", () => {
    expect(make().get(entry(), "/")?.status).toBe(302);
  });

  test("anything that cannot follow a login redirect is told plainly: fetch, a POST, a WebSocket", () => {
    const t = make();
    expect(t.get(entry(), "/api", { "sec-fetch-mode": "cors" })?.status).toBe(401);
    expect(t.get(entry(), "/img.png", { "sec-fetch-mode": "no-cors" })?.status).toBe(401);
    expect(t.get(entry(), "/form", { "sec-fetch-mode": "navigate" }, "POST")?.status).toBe(401);
    expect(t.get(entry(), "/ws", { upgrade: "websocket", connection: "Upgrade" })?.status).toBe(401);
  });

  test("the container never sees an unauthenticated request: the gate answers every one of them", () => {
    const t = make();
    for (const path of ["/", "/admin", "/.env", "/api/secret"]) expect(t.get(entry(), path)).not.toBeNull();
  });
});

describe("the handshake", () => {
  test("a good ticket sets a host-only, HttpOnly, signed cookie and goes back to where the visitor was", () => {
    const t = make();
    const { res } = t.signIn(entry(), "/orders/42?tab=items");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/orders/42?tab=items");
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-gw_pv=01SHOP0000000000000000000A\.\d+\.0\.[A-Za-z0-9_-]{43}; Max-Age=28800; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer"); // the ticket is in THIS url
  });

  test("with the cookie, requests pass -- page loads, fetches, POSTs and WebSocket upgrades alike", () => {
    const t = make();
    const { cookie } = t.signIn(entry());
    expect(t.get(entry(), "/", { cookie })).toBeNull();
    expect(t.get(entry(), "/api", { cookie, "sec-fetch-mode": "cors" })).toBeNull();
    expect(t.get(entry(), "/form", { cookie }, "POST")).toBeNull();
    expect(t.get(entry(), "/ws", { cookie, upgrade: "websocket" })).toBeNull();
    expect(t.get(entry(), "/", { cookie: `theme=dark; ${cookie}; other=1` })).toBeNull();
  });

  test("a ticket works ONCE: by the time it is in a log or a Referer, it is dead", () => {
    const t = make();
    const ticket = t.gate.issueTicket(entry());
    expect(t.get(entry(), `/__gangway/auth?ticket=${ticket}`)?.status).toBe(302);
    expect(t.get(entry(), `/__gangway/auth?ticket=${ticket}`)?.status).toBe(403);
  });

  test("a ticket lasts 60 seconds", () => {
    const t = make();
    const ticket = t.gate.issueTicket(entry());
    t.tick(60_001);
    expect(t.get(entry(), `/__gangway/auth?ticket=${ticket}`)?.status).toBe(403);
  });

  test("a ticket for one preview does not open another -- not by hostname, and not by id", () => {
    const t = make();
    const shop = entry();
    const blog = entry({ hostname: "blog.preview.example.dev", previewId: "01BLOG0000000000000000000B" });
    expect(t.get(blog, `/__gangway/auth?ticket=${t.gate.issueTicket(shop)}`)?.status).toBe(403);
    // Same hostname, a NEW preview behind it (destroyed and redeployed): still no.
    expect(t.get(entry({ previewId: "01SHOP0000000000000000NEW2" }), `/__gangway/auth?ticket=${t.gate.issueTicket(shop)}`)?.status).toBe(403);
  });

  test("forged, truncated, re-signed-with-another-key and garbage tickets are all refused", () => {
    const t = make();
    const good = t.gate.issueTicket(entry());
    const [payload, sig] = good.split(".") as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ h: "shop.preview.example.dev", p: "01SHOP0000000000000000000A", exp: 9_999_999_999_999, n: "x" })).toString("base64url");
    const otherKey = make().gate.issueTicket(entry());
    for (const bad of ["", "x", "a.b", "a.b.c", `${payload}.`, `.${sig}`, `${forgedBody}.${sig}`, `${payload}.${sig}x`, `${payload}.${sig}.extra`, otherKey, "%00", "../../etc/passwd"]) {
      expect(t.get(entry(), `/__gangway/auth?ticket=${encodeURIComponent(bad)}`)?.status).toBe(403);
    }
    expect(t.get(entry(), "/__gangway/auth")?.status).toBe(403);
    // ...and none of that spent the real one.
    expect(t.get(entry(), `/__gangway/auth?ticket=${good}`)?.status).toBe(302);
  });

  test("`to` can only ever be a path on THIS preview: no open redirect", () => {
    const t = make();
    for (const evil of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)", "/__gangway/auth?ticket=x", "", "/ok\r\nSet-Cookie: x=1"]) {
      expect(t.signIn(entry(), evil).res.headers.get("location")).toBe("/");
    }
    expect(safePath("/fine/path?q=1#frag")).toBe("/fine/path?q=1#frag");
    expect(safePath(null)).toBe("/");
  });

  test("only GET redeems a ticket", () => {
    const t = make();
    expect(t.get(entry(), `/__gangway/auth?ticket=${t.gate.issueTicket(entry())}`, {}, "POST")?.status).toBe(404);
  });
});

describe("the gate cookie", () => {
  test("expires after 8 hours", () => {
    const t = make();
    const { cookie } = t.signIn(entry());
    t.tick(8 * 3_600_000 - 1);
    expect(t.get(entry(), "/", { cookie })).toBeNull();
    t.tick(2);
    expect(t.get(entry(), "/", { cookie })?.status).toBe(302);
  });

  test("is bound to the PREVIEW ID: destroy `shop`, deploy a new `shop`, and the old cookie does not open it", () => {
    const t = make();
    const { cookie } = t.signIn(entry());
    expect(t.get(entry({ previewId: "01SHOP0000000000000000NEW2" }), "/", { cookie })?.status).toBe(302);
  });

  test("cannot be forged, extended, or replayed as a ticket", () => {
    const t = make();
    const { cookie } = t.signIn(entry());
    const [, value] = cookie.split("=") as [string, string];
    const [id, exp, sig] = value.split(".") as [string, string, string];
    for (const bad of [`${id}.${Number(exp) + 1}.${sig}`, `01OTHER.${exp}.${sig}`, `${id}.${exp}.`, `${id}.${exp}`, `${id}.${exp}.${sig}.x`, "garbage", ""]) {
      expect(t.get(entry(), "/", { cookie: `${GATE_COOKIE}=${bad}` })?.status).toBe(302);
    }
    // Domain separation: a cookie's signature is not a ticket's, even over a payload an attacker chose.
    expect(t.get(entry(), `/__gangway/auth?ticket=${Buffer.from(`${id}.${exp}`).toString("base64url")}.${sig}`)?.status).toBe(403);
  });

  test("a key from another install opens nothing; the same key across a restart keeps visitors in", () => {
    const key = randomBytes(32);
    const { cookie } = make(key).signIn(entry());
    expect(make(key).get(entry(), "/", { cookie })).toBeNull();
    expect(make().get(entry(), "/", { cookie })?.status).toBe(302);
  });

  test("a short key is refused at construction", () => {
    expect(() => new PreviewGate({ key: randomBytes(16), appOrigin: () => APP })).toThrow(/32 bytes/);
  });
});

describe("what the preview's own code is allowed to see", () => {
  test("gangway's cookies are stripped from the request before it is forwarded; the app's own survive", () => {
    const t = make();
    const { cookie } = t.signIn(entry());
    const req = new Request("https://shop.preview.example.dev/", { headers: { cookie: `sid=abc; ${cookie}; __Host-gw_session=SESSIONSECRET; theme=dark` } });
    const forwarded = buildUpstreamHeaders(req, { clientHost: "shop.preview.example.dev", clientIp: "203.0.113.7", publicPort: 443 });
    expect(forwarded.get("cookie")).toBe("sid=abc; theme=dark");
  });

  test("when ours were the only cookies, no Cookie header is sent at all", () => {
    const req = new Request("https://shop.preview.example.dev/", { headers: { cookie: `${GATE_COOKIE}=a.b.c` } });
    expect(buildUpstreamHeaders(req, { clientHost: "x", clientIp: "::1", publicPort: 443 }).has("cookie")).toBe(false);
  });

  test("stripGangwayCookies", () => {
    expect(stripGangwayCookies(null)).toBeNull();
    expect(stripGangwayCookies("a=1")).toBe("a=1");
    expect(stripGangwayCookies("__Host-gw_pv=x; a=1;  __Host-gw_session=y ;b=2")).toBe("a=1; b=2");
    expect(stripGangwayCookies("__host-gw_pv=x")).toBe("__host-gw_pv=x"); // cookie names are case-sensitive; not ours
  });
});

describe("loadOrCreateGateKey", () => {
  test("creates once, then returns the same key; replaces one that is too short", () => {
    const data = new Map<string, unknown>();
    const store = { get: (k: string) => data.get(k), set: (k: string, v: unknown) => void data.set(k, v) };
    const first = loadOrCreateGateKey(store);
    expect(first).toHaveLength(32);
    expect(loadOrCreateGateKey(store).equals(first)).toBe(true);
    data.set("auth.gateKey", "c2hvcnQ=");
    expect(loadOrCreateGateKey(store)).toHaveLength(32);
  });
});
