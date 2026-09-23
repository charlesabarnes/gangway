/**
 * The proxy's upstream leg, over node:http. Bun's fetch does not work as a proxy client:
 * it decompresses bodies but leaves Content-Encoding on the response, and it buffers
 * streamed uploads in memory.
 */
import http from "node:http";
import type net from "node:net";
import type { RouteEntry } from "../routing/table.ts";
import { dialUpstream, type DialConfig } from "./dial.ts";
import { buildResponseHeaders, buildUpstreamHeaders, type ForwardContext } from "./headers.ts";
import { BodyTooLarge, capBody, type Limits } from "./limits.ts";

export type UpstreamOptions = {
  dial: DialConfig;
  limits: Limits;
  timeoutMs: number;
  publicPort: number;
};

export interface Upstream {
  readonly name: string;
  fetch(req: Request, entry: RouteEntry, ctx: { clientIp: string }): Promise<Response>;
}

function forwardContext(entry: RouteEntry, o: UpstreamOptions, clientIp: string): ForwardContext {
  return { clientHost: entry.hostname, clientIp, publicPort: o.publicPort };
}

/** Agent that routes every connection through dial.ts, so SOCKS5 and direct look alike. */
function agentFor(o: UpstreamOptions): http.Agent {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  // @ts-expect-error -- createConnection is a documented Agent hook, loosely typed.
  agent.createConnection = (
    opts: { host: string; port: number },
    cb: (e: Error | null, s?: net.Socket) => void,
  ) => {
    dialUpstream({ host: opts.host, port: opts.port }, o.dial)
      .then((s) => cb(null, s))
      .catch((e) => cb(e as Error));
  };
  return agent;
}

export class NodeHttpUpstream implements Upstream {
  readonly name = "node-http";
  readonly #o: UpstreamOptions;
  readonly #agent: http.Agent;

  constructor(o: UpstreamOptions) {
    this.#o = o;
    this.#agent = agentFor(o);
  }

  fetch(req: Request, entry: RouteEntry, ctx: { clientIp: string }): Promise<Response> {
    const url = new URL(req.url);
    const headers = buildUpstreamHeaders(req, forwardContext(entry, this.#o, ctx.clientIp));
    const hdr: Record<string, string> = {};
    headers.forEach((v, k) => {
      hdr[k] = v;
    });

    return new Promise<Response>((resolve, reject) => {
      // Destroying a pooled socket surfaces ECONNRESET rather than our own error, so the
      // reason has to be tracked out of band or a timeout is misreported as a bad gateway.
      let timedOut = false;
      const creq = http.request(
        {
          host: entry.upstreamHost,
          port: entry.upstreamPort,
          method: req.method,
          // Never normalize the path: collapsing // or decoding %2F breaks real apps.
          path: url.pathname + url.search,
          headers: hdr,
          agent: this.#agent,
        },
        (cres) => {
          const out = new Headers();
          for (const [k, v] of Object.entries(cres.headers)) {
            if (v === undefined) continue;
            out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
          }
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              cres.on("data", (d: Buffer) => c.enqueue(new Uint8Array(d)));
              cres.on("end", () => {
                try {
                  c.close();
                } catch {
                  /* already closed */
                }
              });
              cres.on("error", (e) => {
                try {
                  c.error(e);
                } catch {
                  /* already errored */
                }
              });
            },
            cancel() {
              cres.destroy();
            },
          });
          resolve(
            new Response(cres.statusCode === 204 || cres.statusCode === 304 ? null : body, {
              status: cres.statusCode ?? 502,
              headers: buildResponseHeaders(out, { unlisted: entry.visibility === "unlisted" }),
            }),
          );
        },
      );

      creq.setTimeout(this.#o.timeoutMs, () => {
        timedOut = true;
        creq.destroy(new Error("UPSTREAM_TIMEOUT"));
      });
      creq.on("error", (e) => reject(timedOut ? new UpstreamTimeout() : e));
      req.signal.addEventListener("abort", () => creq.destroy(new Error("CLIENT_ABORTED")), {
        once: true,
      });

      if (req.body) {
        void (async () => {
          const reader = capBody(req.body!, this.#o.limits.maxBodyBytes, entry).getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!creq.write(value)) await new Promise((r) => creq.once("drain", r));
            }
            creq.end();
          } catch (e) {
            creq.destroy(e as Error);
          }
        })();
      } else {
        creq.end();
      }
    });
  }
}

export function isBodyTooLarge(e: unknown): boolean {
  return e instanceof BodyTooLarge || String((e as Error)?.message ?? "").includes("BodyTooLarge");
}

export class UpstreamTimeout extends Error {
  constructor() {
    super("UPSTREAM_TIMEOUT");
    this.name = "UpstreamTimeout";
  }
}

export function isTimeout(e: unknown): boolean {
  if (e instanceof UpstreamTimeout) return true;
  const m = String((e as Error)?.message ?? "");
  return (
    m.includes("UPSTREAM_TIMEOUT") ||
    m.includes("timed out") ||
    (e as Error)?.name === "TimeoutError"
  );
}

/**
 * One upstream per Docker host, built on first use and kept (each owns a keep-alive
 * agent). Hosts differ in how they are reached -- directly, or through a SOCKS tunnel --
 * and a single shared dial config sends the second host's traffic down the first's path.
 */
export class PerHostUpstream implements Upstream {
  readonly name = "per-host";
  readonly #make: (hostId: string) => Upstream | null;
  readonly #byHost = new Map<string, Upstream>();

  constructor(make: (hostId: string) => Upstream | null) {
    this.#make = make;
  }

  fetch(req: Request, entry: RouteEntry, ctx: { clientIp: string }): Promise<Response> {
    let upstream = this.#byHost.get(entry.hostId);
    if (!upstream) {
      const made = this.#make(entry.hostId);
      // A route on a host that no longer exists: there is nowhere to send this. The
      // dispatcher turns the throw into its 502 page.
      if (!made) return Promise.reject(new Error(`no such host: ${entry.hostId}`));
      this.#byHost.set(entry.hostId, (upstream = made));
    }
    return upstream.fetch(req, entry, ctx);
  }
}
