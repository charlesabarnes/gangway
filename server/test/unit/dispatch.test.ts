import { describe, expect, test } from "bun:test";
import { dispatch, type DispatchDeps, type Surface } from "../../src/net/dispatch.ts";
import { DEFAULT_LIMITS } from "../../src/net/limits.ts";
import type { RouteEntry } from "../../src/routing/table.ts";
import type { PreviewState } from "@gangway/shared/domain";

const BASE = "preview.example.com";

function entry(over: Partial<RouteEntry> = {}): RouteEntry {
  return {
    hostname: `acme-pr-1.${BASE}`,
    previewId: "p1",
    hostId: "local",
    project: "gw-1",
    service: "web",
    containerPort: 3000,
    upstreamHost: "127.0.0.1",
    upstreamPort: 31000,
    primary: true,
    visibility: "public",
    password: { mode: "inherit" },
    passwordLogin: "inherit",
    state: "awake",
    inflight: 0,
    bytesInFlight: 0,
    lastSeenAt: 0,
    ...over,
  };
}

function deps(over: Partial<DispatchDeps> = {}, e: RouteEntry | null = entry()): DispatchDeps {
  const table = {
    lookup: (h: string) => (e && h === e.hostname ? e : undefined),
  } as unknown as DispatchDeps["table"];
  return {
    baseDomain: () => BASE,
    table,
    upstream: { name: "stub", fetch: async () => new Response("upstream-ok", { status: 200 }) },
    limits: DEFAULT_LIMITS,
    surfaceEnabled: () => true,
    handlers: {
      app: () => new Response("APP", { status: 200 }),
      api: () => new Response("API", { status: 200 }),
      mcp: () => new Response("MCP", { status: 200 }),
      hooks: () => new Response("HOOKS", { status: 200 }),
    },
    clientIpFor: () => "10.0.0.1",
    ...over,
  };
}

const get = (host: string, init: RequestInit = {}) =>
  new Request("https://ignored.example/path?q=1", {
    ...init,
    headers: { host, ...(init.headers ?? {}) },
  });

describe("host normalization and scoping", () => {
  test("a missing Host is a 400", async () => {
    const req = new Request("https://x/");
    req.headers.delete("host");
    expect((await dispatch(req, deps())).status).toBe(400);
  });

  test("a hostname outside the base domain is 421 Misdirected", async () => {
    expect((await dispatch(get("evil.com"), deps())).status).toBe(421);
    expect((await dispatch(get(`${BASE}.evil.com`), deps())).status).toBe(421);
  });

  test("a multi-label subdomain is refused -- no wildcard covers it", async () => {
    expect((await dispatch(get(`api.acme-pr-1.${BASE}`), deps())).status).toBe(421);
  });

  test("case, port and trailing dot are normalized before lookup", async () => {
    for (const h of [
      `ACME-PR-1.${BASE.toUpperCase()}`,
      `acme-pr-1.${BASE}:8443`,
      `acme-pr-1.${BASE}.`,
    ]) {
      const res = await dispatch(get(h), deps());
      expect(await res.text()).toBe("upstream-ok");
    }
  });
});

describe("reserved labels", () => {
  test.each([
    ["app", "APP"],
    ["api", "API"],
    ["mcp", "MCP"],
    ["hooks", "HOOKS"],
  ])("%s routes to its own surface", async (label, body) => {
    const res = await dispatch(get(`${label}.${BASE}`), deps());
    expect(await res.text()).toBe(body);
  });

  test("www is an alias for the app surface", async () => {
    expect(await (await dispatch(get(`www.${BASE}`), deps())).text()).toBe("APP");
  });

  test("the apex serves the app surface", async () => {
    expect(await (await dispatch(get(BASE), deps())).text()).toBe("APP");
  });

  test("a PR on a repo named `api` cannot hijack the control plane", async () => {
    // A live route claiming the reserved hostname must still lose to the surface.
    const hijack = entry({ hostname: `api.${BASE}` });
    const res = await dispatch(get(`api.${BASE}`), deps({}, hijack));
    expect(await res.text()).toBe("API");
  });

  test("a disabled surface is 404, never 503", async () => {
    // Do not advertise what is there but switched off.
    const res = await dispatch(
      get(`mcp.${BASE}`),
      deps({ surfaceEnabled: (s: Surface) => s !== "mcp" }),
    );
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(503);
  });

  test("the toggle is read per request, so no restart is needed", async () => {
    let on = true;
    const d = deps({ surfaceEnabled: () => on });
    expect((await dispatch(get(`mcp.${BASE}`), d)).status).toBe(200);
    on = false;
    expect((await dispatch(get(`mcp.${BASE}`), d)).status).toBe(404);
  });

  test("a reserved label with no handler is 404", async () => {
    const res = await dispatch(get(`registry.${BASE}`), deps());
    expect(res.status).toBe(404);
  });
});

describe("preview state machine", () => {
  test("unknown hostname is 404", async () => {
    expect((await dispatch(get(`nope.${BASE}`), deps({}, null))).status).toBe(404);
  });

  test("awake proxies", async () => {
    expect(await (await dispatch(get(`acme-pr-1.${BASE}`), deps())).text()).toBe("upstream-ok");
  });

  test.each(["building", "starting"] as PreviewState[])(
    "%s returns 202 with a refresh, not 502",
    async (state) => {
      const res = await dispatch(get(`acme-pr-1.${BASE}`), deps({}, entry({ state })));
      expect(res.status).toBe(202);
      expect(await res.text()).toContain('http-equiv="refresh"');
    },
  );

  test("failed returns 502 with the last log lines", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`);
    const res = await dispatch(
      get(`acme-pr-1.${BASE}`),
      deps({ logTailFor: () => lines }, entry({ state: "failed" })),
    );
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("line 79");
    expect(body).not.toContain("line 29"); // only the last 50
  });

  test("asleep: wake answering null means awake now -- THIS request is proxied; a Response is sent instead; unwired shows the waking page", async () => {
    // The wake flips the entry to awake (as the state machine does through the table) and says "proxy it".
    const e = entry({ state: "asleep" });
    const proxied = await dispatch(
      get(`acme-pr-1.${BASE}`),
      deps(
        {
          wake: async (en) => {
            en.state = "awake";
            return null;
          },
        },
        e,
      ),
    );
    expect(await proxied.text()).toBe("upstream-ok");

    const slow = await dispatch(
      get(`acme-pr-1.${BASE}`),
      deps(
        { wake: async () => new Response("still waking", { status: 202 }) },
        entry({ state: "asleep" }),
      ),
    );
    expect(slow.status).toBe(202);
    expect(await slow.text()).toBe("still waking");

    const res = await dispatch(get(`acme-pr-1.${BASE}`), deps({}, entry({ state: "asleep" })));
    expect(res.status).toBe(202);
  });

  test.each(["destroying", "destroyed"] as PreviewState[])("%s is 404", async (state) => {
    expect((await dispatch(get(`acme-pr-1.${BASE}`), deps({}, entry({ state })))).status).toBe(404);
  });

  test("error pages never leak a stack trace", async () => {
    const res = await dispatch(
      get(`acme-pr-1.${BASE}`),
      deps({
        upstream: {
          name: "boom",
          fetch: async () => {
            throw new Error("SECRET internal detail at /src/x.ts:42");
          },
        },
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("src/x.ts");
  });

  test("a hostname is escaped into the error page, not interpolated raw", async () => {
    const res = await dispatch(get(`evil.${BASE}`), deps({}, null));
    expect(await res.text()).not.toContain("<script>");
  });
});

describe("visibility gate", () => {
  test("runs before the upstream ever sees the request", async () => {
    let upstreamCalled = false;
    const res = await dispatch(
      get(`acme-pr-1.${BASE}`),
      deps(
        {
          upstream: {
            name: "s",
            fetch: async () => {
              upstreamCalled = true;
              return new Response("x");
            },
          },
          visibilityGate: () =>
            new Response(null, { status: 302, headers: { location: "/login" } }),
        },
        entry({ visibility: "private" }),
      ),
    );
    expect(res.status).toBe(302);
    expect(upstreamCalled).toBe(false);
  });
});

describe("limits", () => {
  test("past the in-flight cap the preview is 503, and the counter is released after", async () => {
    const e = entry();
    const d = deps({ limits: { ...DEFAULT_LIMITS, maxInflight: 1 } }, e);
    e.inflight = 1;
    expect((await dispatch(get(e.hostname), d)).status).toBe(503);

    e.inflight = 0;
    expect((await dispatch(get(e.hostname), d)).status).toBe(200);
    expect(e.inflight).toBe(0); // released in finally
  });

  test("the in-flight counter is released even when the upstream throws", async () => {
    const e = entry();
    await dispatch(
      get(e.hostname),
      deps(
        {
          upstream: {
            name: "s",
            fetch: async () => {
              throw new Error("boom");
            },
          },
        },
        e,
      ),
    );
    expect(e.inflight).toBe(0);
  });

  test("an oversized body maps to 413 and a timeout to 504", async () => {
    const { BodyTooLarge } = await import("../../src/net/limits.ts");
    const e = entry();
    const big = await dispatch(
      get(e.hostname),
      deps(
        {
          upstream: {
            name: "s",
            fetch: async () => {
              throw new BodyTooLarge(10);
            },
          },
        },
        e,
      ),
    );
    expect(big.status).toBe(413);

    const slow = await dispatch(
      get(e.hostname),
      deps(
        {
          upstream: {
            name: "s",
            fetch: async () => {
              throw new Error("UPSTREAM_TIMEOUT");
            },
          },
        },
        e,
      ),
    );
    expect(slow.status).toBe(504);
  });
});

describe("PerHostUpstream", () => {
  test("each host gets its OWN upstream, built once; a route on a vanished host is an error, not the first host's traffic", async () => {
    const { PerHostUpstream } = await import("../../src/net/upstream.ts");
    const made: string[] = [];
    const per = new PerHostUpstream((hostId) => {
      if (hostId === "gone") return null;
      made.push(hostId);
      return { name: hostId, fetch: async () => new Response(`via ${hostId}`) };
    });
    const req = new Request("https://x.preview.example.com/");
    const via = async (hostId: string) =>
      (await per.fetch(req, entry({ hostId }), { clientIp: "::1" })).text();
    expect(await via("docker-host")).toBe("via docker-host");
    expect(await via("laptop")).toBe("via laptop");
    expect(await via("docker-host")).toBe("via docker-host");
    expect(made).toEqual(["docker-host", "laptop"]);
    await expect(per.fetch(req, entry({ hostId: "gone" }), { clientIp: "::1" })).rejects.toThrow(
      "no such host: gone",
    );
  });
});
