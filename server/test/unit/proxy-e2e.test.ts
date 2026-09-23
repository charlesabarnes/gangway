/**
 * The entire proxy, end to end, with NO Docker: a real Bun.serve upstream on loopback, a
 * real gangway listener with a real TLS cert, and a client that does not decompress.
 *
 * These are spike S0's assertions made permanent. They would have caught every bug that
 * spike was built to look for, and they run in CI forever.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
// Bun.Server is generic over its websocket data type.
type AnyServer = Server<unknown>;
import * as tls from "node:tls";
import { createCa, issueLeaf } from "../../src/tls/selfsigned.ts";
import { CertStore } from "../../src/tls/certstore.ts";
import { startListener, type RunningListener } from "../../src/net/listener.ts";
import { NodeHttpUpstream } from "../../src/net/upstream.ts";
import { DEFAULT_LIMITS } from "../../src/net/limits.ts";
import type { RouteEntry } from "../../src/routing/table.ts";
import type { DispatchDeps } from "../../src/net/dispatch.ts";

const BASE = "preview.test.invalid";
const PREVIEW = `fixture-web.${BASE}`;

let upstream: AnyServer;
let listener: RunningListener;
let store: CertStore;
let entry: RouteEntry;
let caPem: string;

/** Raw TLS client: sets Host and SNI independently and never inflates the body. */
function raw(opts: {
  host: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>(
    (resolve, reject) => {
      const s = tls.connect(
        {
          host: "127.0.0.1",
          port: listener.port,
          servername: opts.host,
          rejectUnauthorized: false,
        },
        () => {
          const h: Record<string, string> = {
            host: opts.host,
            connection: "close",
            ...(opts.headers ?? {}),
          };
          if (opts.body !== undefined) h["content-length"] = String(Buffer.byteLength(opts.body));
          const head = Object.entries(h)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
          s.write(`${opts.method ?? "GET"} ${opts.path} HTTP/1.1\r\n${head}\r\n\r\n`);
          if (opts.body !== undefined) s.write(opts.body);
        },
      );
      const chunks: Buffer[] = [];
      s.on("data", (d: Buffer | string) => chunks.push(typeof d === "string" ? Buffer.from(d) : d));
      s.on("error", reject);
      s.on("end", () => {
        const buf = Buffer.concat(chunks);
        const sep = buf.indexOf("\r\n\r\n");
        const head = buf.subarray(0, sep).toString("latin1").split("\r\n");
        const headers: Record<string, string> = {};
        for (const line of head.slice(1)) {
          const i = line.indexOf(":");
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        let body = buf.subarray(sep + 4);
        if (headers["transfer-encoding"] === "chunked") {
          const out: Buffer[] = [];
          let p = 0;
          for (;;) {
            const e = body.indexOf("\r\n", p);
            if (e < 0) break;
            const n = parseInt(body.subarray(p, e).toString("latin1"), 16);
            if (!n) break;
            out.push(body.subarray(e + 2, e + 2 + n));
            p = e + 2 + n + 2;
          }
          body = Buffer.concat(out);
        }
        resolve({ status: Number(head[0]!.split(" ")[1]), headers, body });
      });
    },
  );
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const p = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const ok = p
          ? server.upgrade(req, { data: null, headers: { "Sec-WebSocket-Protocol": p } })
          : server.upgrade(req, { data: null });
        return ok ? undefined : new Response("no", { status: 400 });
      }
      if (url.pathname.startsWith("/echo")) {
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          h[k] = v;
        });
        return Response.json({
          host: req.headers.get("host"),
          path: url.pathname + url.search,
          headers: h,
        });
      }
      if (url.pathname === "/gzip") {
        return new Response(Bun.gzipSync(Buffer.from("x".repeat(5000))), {
          headers: { "content-encoding": "gzip", "content-type": "text/plain" },
        });
      }
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: "/login" } });
      }
      if (url.pathname === "/sse") {
        server.timeout(req, 0);
        let n = 0;
        let t: Timer;
        return new Response(
          new ReadableStream({
            start(c) {
              t = setInterval(() => {
                try {
                  c.enqueue(new TextEncoder().encode(`data: ${n++}\n\n`));
                } catch {
                  clearInterval(t);
                }
              }, 100);
            },
            cancel() {
              clearInterval(t);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname === "/slow") {
        server.timeout(req, 0);
        return Bun.sleep(30_000).then(() => new Response("late"));
      }
      if (url.pathname === "/count" && req.method === "POST") {
        server.timeout(req, 0);
        return req.arrayBuffer().then((b) => Response.json({ bytes: b.byteLength }));
      }
      return new Response("nope", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 8 * 1024 * 1024,
      message(ws, m) {
        ws.send(m);
      },
      close() {},
    },
  });

  const ca = await createCa();
  caPem = ca.certPem;
  store = new CertStore({ materials: [await issueLeaf(ca, [`*.${BASE}`, BASE])] });

  entry = {
    hostname: PREVIEW,
    previewId: "p1",
    hostId: "local",
    project: "gw-1",
    service: "web",
    containerPort: 3000,
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port!,
    primary: true,
    visibility: "public",
    password: { mode: "inherit" },
    passwordLogin: "inherit",
    state: "awake",
    inflight: 0,
    bytesInFlight: 0,
    lastSeenAt: 0,
  };

  const deps: DispatchDeps = {
    baseDomain: () => BASE,
    table: {
      lookup: (h: string) => (h === PREVIEW ? entry : undefined),
    } as unknown as DispatchDeps["table"],
    upstream: new NodeHttpUpstream({
      dial: { dial: "direct" },
      limits: { ...DEFAULT_LIMITS, maxBodyBytes: 4 * 1024 * 1024 },
      timeoutMs: 1500,
      publicPort: 8443,
    }),
    limits: DEFAULT_LIMITS,
    surfaceEnabled: () => true,
    handlers: { app: () => new Response("APP") },
    clientIpFor: () => "10.9.9.9",
  };

  listener = startListener({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 64 * 1024 * 1024,
    idleTimeout: 10,
    certStore: store,
    deps,
  });
});

afterAll(() => {
  listener?.stop(true);
  void upstream?.stop(true);
});

describe("headers (§6.4)", () => {
  test("the ORIGINAL Host reaches the upstream, and X-Forwarded-* are set", async () => {
    const r = await raw({ host: PREVIEW, path: "/echo?a=1" });
    const j = JSON.parse(r.body.toString());
    expect(j.host).toBe(PREVIEW); // else frameworks redirect to http://localhost
    expect(j.headers["x-forwarded-proto"]).toBe("https");
    expect(j.headers["x-forwarded-host"]).toBe(PREVIEW);
    expect(j.headers["x-forwarded-port"]).toBe("8443");
    expect(j.path).toBe("/echo?a=1"); // query preserved
  });

  test("client-supplied X-Forwarded-* are stripped, not appended to", async () => {
    const r = await raw({
      host: PREVIEW,
      path: "/echo",
      headers: {
        "x-forwarded-proto": "http",
        "x-forwarded-for": "6.6.6.6",
        "x-forwarded-host": "evil.com",
      },
    });
    const j = JSON.parse(r.body.toString());
    expect(j.headers["x-forwarded-proto"]).toBe("https");
    expect(j.headers["x-forwarded-for"]).toBe("10.9.9.9");
    expect(j.headers["x-forwarded-host"]).toBe(PREVIEW);
  });

  test("the path is not normalized -- // and %2F survive", async () => {
    const r = await raw({ host: PREVIEW, path: "/echo//a%2Fb" });
    expect(JSON.parse(r.body.toString()).path).toBe("/echo//a%2Fb");
  });

  test("an upstream redirect reaches the browser rather than being followed", async () => {
    const r = await raw({ host: PREVIEW, path: "/redirect" });
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toBe("/login");
  });

  test("gzip passes through intact on the wire", async () => {
    const r = await raw({ host: PREVIEW, path: "/gzip", headers: { "accept-encoding": "gzip" } });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.body[0]).toBe(0x1f);
    expect(r.body[1]).toBe(0x8b); // still compressed: header and body agree
    expect(r.body.length).toBeLessThan(200); // 5000 bytes of 'x' compress hard
  });

  test("unlisted previews get X-Robots-Tag, public ones do not", async () => {
    entry.visibility = "unlisted";
    expect((await raw({ host: PREVIEW, path: "/echo" })).headers["x-robots-tag"]).toContain(
      "noindex",
    );
    entry.visibility = "public";
    expect((await raw({ host: PREVIEW, path: "/echo" })).headers["x-robots-tag"]).toBeUndefined();
  });
});

describe("TLS", () => {
  test("SNI presents the wildcard certificate", async () => {
    const serial = await new Promise<string>((res, rej) => {
      const s = tls.connect(
        { host: "127.0.0.1", port: listener.port, servername: PREVIEW, rejectUnauthorized: false },
        () => {
          const c = s.getPeerCertificate();
          res(c.serialNumber);
          s.destroy();
        },
      );
      s.on("error", rej);
    });
    expect(serial).toBeTruthy();
  });

  test("the leaf chains to the dev CA, so a client trusting the CA verifies it", async () => {
    const ok = await new Promise<boolean>((res) => {
      const s = tls.connect(
        { host: "127.0.0.1", port: listener.port, servername: PREVIEW, ca: [caPem] },
        () => {
          res(s.authorized);
          s.destroy();
        },
      );
      s.on("error", () => res(false));
    });
    expect(ok).toBe(true);
  });

  test("hot-swap: a NEW connection sees the new certificate, via SO_REUSEPORT rebind", async () => {
    // server.reload({tls}) does not do this on Bun 1.4.2 -- see ADR-0002.
    const serialOf = () =>
      new Promise<string>((res, rej) => {
        const s = tls.connect(
          {
            host: "127.0.0.1",
            port: listener.port,
            servername: PREVIEW,
            rejectUnauthorized: false,
          },
          () => {
            res(s.getPeerCertificate().serialNumber);
            s.destroy();
          },
        );
        s.on("error", rej);
      });
    const before = await serialOf();
    const ca = await createCa();
    await store.swap({ materials: [await issueLeaf(ca, [`*.${BASE}`, BASE])] });
    listener.swapCerts();

    let after = before;
    for (let i = 0; i < 20 && after === before; i++) {
      await Bun.sleep(50);
      after = await serialOf();
    }
    expect(after).not.toBe(before);
    expect((await raw({ host: PREVIEW, path: "/echo" })).status).toBe(200); // still serving
  });
});

describe("streaming and limits", () => {
  test("SSE is not buffered and outlives the idle timeout", async () => {
    const res = await fetch(`https://127.0.0.1:${listener.port}/sse`, {
      headers: { host: PREVIEW },
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    const reader = res.body!.getReader();
    const t0 = Date.now();
    let ticks = 0;
    while (Date.now() - t0 < 11_000) {
      const { done, value } = await reader.read();
      if (done) break;
      ticks += (new TextDecoder().decode(value).match(/data: /g) ?? []).length;
    }
    void reader.cancel();
    expect(ticks).toBeGreaterThan(20);
    expect(Date.now() - t0).toBeGreaterThan(10_000); // survived idleTimeout: 10
  }, 20_000);

  test("a body over the cap is 413, and one under it streams through", async () => {
    const ok = await raw({
      host: PREVIEW,
      path: "/count",
      method: "POST",
      body: "x".repeat(64 * 1024),
    });
    expect(JSON.parse(ok.body.toString()).bytes).toBe(64 * 1024);

    const big = await raw({
      host: PREVIEW,
      path: "/count",
      method: "POST",
      body: "x".repeat(5 * 1024 * 1024),
    });
    expect(big.status).toBe(413);
  }, 20_000);

  test("a slow upstream becomes 504, not a hang", async () => {
    const r = await raw({ host: PREVIEW, path: "/slow" });
    expect(r.status).toBe(504);
  }, 10_000);

  test("a dead upstream becomes 502 with no stack trace", async () => {
    const saved = entry.upstreamPort;
    entry.upstreamPort = 1; // nothing listening
    const r = await raw({ host: PREVIEW, path: "/echo" });
    entry.upstreamPort = saved;
    expect(r.status).toBe(502);
    expect(r.body.toString()).not.toContain("ECONNREFUSED");
  });
});

describe("WebSocket relay (§6.4 -- fails silently when wrong)", () => {
  test("echoes text and binary, negotiates a subprotocol, propagates close", async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${listener.port}/ws`, {
      protocols: ["gangway-v1"],
      headers: { host: PREVIEW },
      tls: { rejectUnauthorized: false },
    });
    ws.binaryType = "arraybuffer";

    const opened = await new Promise<boolean>((res) => {
      ws.onopen = () => res(true);
      ws.onerror = () => res(false);
      setTimeout(() => res(false), 5000);
    });
    expect(opened).toBe(true);
    expect(ws.protocol).toBe("gangway-v1");

    let n = 0;
    const text = await new Promise<boolean>((res) => {
      ws.onmessage = (e) => {
        if (e.data !== `m${n}`) return res(false);
        if (++n >= 200) return res(true);
        ws.send(`m${n}`);
      };
      ws.send("m0");
      setTimeout(() => res(false), 10_000);
    });
    expect(text).toBe(true);

    const big = new Uint8Array(512 * 1024).fill(7);
    const binary = await new Promise<boolean>((res) => {
      ws.onmessage = (e) => {
        const b = new Uint8Array(e.data as ArrayBuffer);
        res(b.byteLength === big.byteLength && b[0] === 7);
      };
      ws.send(big);
      setTimeout(() => res(false), 10_000);
    });
    expect(binary).toBe(true);

    const code = await new Promise<number>((res) => {
      ws.onclose = (e) => res(e.code);
      ws.close(1000, "bye");
      setTimeout(() => res(-1), 5000);
    });
    expect(code).toBe(1000);
  }, 30_000);
});
