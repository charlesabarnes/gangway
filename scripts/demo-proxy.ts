/**
 * Runnable smoke demo of the spine so far: real TLS, real Host-header dispatch, real
 * reverse proxy. No Docker, no deploy pipeline yet -- it proxies to a local fixture.
 *
 *   bun run scripts/demo-proxy.ts
 */
import { CertStore } from "../server/src/tls/certstore.ts";
import { SelfSignedProvider } from "../server/src/tls/provider.ts";
import { startListener } from "../server/src/net/listener.ts";
import { NodeHttpUpstream } from "../server/src/net/upstream.ts";
import { DEFAULT_LIMITS } from "../server/src/net/limits.ts";
import type { RouteEntry } from "../server/src/routing/table.ts";
import type { DispatchDeps } from "../server/src/net/dispatch.ts";
import { publicUrlFor } from "../shared/src/url.ts";

const BASE = "preview.localhost";
const PORT = Number(process.env["PORT"] ?? 8443);

// Stand-in for a preview container.
const fixture = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/ws") return new Response("ws fixture", { status: 426 });
    return Response.json({
      iAm: "a preview container",
      hostYouSent: req.headers.get("host"),
      xForwardedProto: req.headers.get("x-forwarded-proto"),
      path: u.pathname,
    });
  },
});

const bundle = await new SelfSignedProvider("./state").ensure([`*.${BASE}`, BASE]);
const store = new CertStore(bundle);

const routes = new Map<string, RouteEntry>();
for (const [label, service] of [["acme-pr-1", "web"], ["acme-pr-1-api", "api"]] as const) {
  routes.set(`${label}.${BASE}`, {
    hostname: `${label}.${BASE}`, previewId: "demo", project: "gw-demo", service,
    containerPort: 3000, upstreamHost: "127.0.0.1", upstreamPort: fixture.port!,
    primary: service === "web", visibility: "public", state: "awake",
    inflight: 0, bytesInFlight: 0, lastSeenAt: 0,
  });
}
// A preview mid-build, to show the 202 page rather than a bare 502.
routes.set(`building-demo.${BASE}`, { ...routes.get(`acme-pr-1.${BASE}`)!, hostname: `building-demo.${BASE}`, state: "building" });

const deps: DispatchDeps = {
  baseDomain: () => BASE,
  table: { lookup: (h: string) => routes.get(h) } as unknown as DispatchDeps["table"],
  upstream: new NodeHttpUpstream({ dial: { dial: "direct" }, limits: DEFAULT_LIMITS, timeoutMs: 30_000, publicPort: PORT }),
  limits: DEFAULT_LIMITS,
  surfaceEnabled: (s) => s !== "mcp", // MCP is opt-in (§10.5); shows the 404 behaviour
  handlers: {
    app: () => new Response("<h1>gangway UI would be here</h1>", { headers: { "content-type": "text/html" } }),
    api: () => Response.json({ ok: true, routes: [...routes.keys()] }),
  },
  clientIpFor: () => "127.0.0.1",
};

const listener = startListener({
  hostname: "::", port: PORT, maxRequestBodySize: 512 * 1024 * 1024,
  idleTimeout: 120, certStore: store, deps,
});

const origin = (h: string) => publicUrlFor(h, { scheme: "https", port: PORT });
console.log(`
gangway demo listening on :${listener.port}

  CA to trust:  ${bundle.caPath}
  curl flag:    --cacert ${bundle.caPath}

Try:
  curl --cacert ${bundle.caPath} ${origin(`app.${BASE}`)}
  curl --cacert ${bundle.caPath} ${origin(`api.${BASE}`)}
  curl --cacert ${bundle.caPath} ${origin(`acme-pr-1.${BASE}`)}
  curl --cacert ${bundle.caPath} ${origin(`acme-pr-1-api.${BASE}`)}
  curl -i --cacert ${bundle.caPath} ${origin(`building-demo.${BASE}`)}   # 202 + refresh
  curl -i --cacert ${bundle.caPath} ${origin(`mcp.${BASE}`)}             # 404, surface off
  curl -i --cacert ${bundle.caPath} ${origin(`nope.${BASE}`)}            # 404, no such preview

Ctrl-C to stop.`);

process.on("SIGINT", () => { listener.stop(true); fixture.stop(true); process.exit(0); });
