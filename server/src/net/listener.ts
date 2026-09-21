/**
 * The single TLS listener (§3.1). One socket, dispatched on the Host header.
 *
 * ADR-0002: `Bun.serve` rather than node:tls + an SNI callback. Hono is fetch-based and
 * Bun.serve is fetch-based, so the preview proxy is just another fetch handler and there
 * is no fetch-world/raw-socket seam on the normal request path.
 */
import type { Server } from "bun";
import type { CertStore } from "../tls/certstore.ts";
import { dispatch, type DispatchDeps } from "./dispatch.ts";
import { isWebSocketUpgrade } from "./headers.ts";
import { labelUnder, normalizeHost, RESERVED_LABELS } from "../../../shared/src/hostname.ts";
import { wsRelay, type WsData } from "./wsrelay.ts";

/**
 * The peer address, stashed per request. Only the listener can see the socket, and the
 * dispatcher only sees the Request -- a WeakMap joins them without widening either
 * signature, and cannot leak: the entry dies with the Request.
 */
const peers = new WeakMap<Request, string>();
export const clientIpOf = (req: Request): string => peers.get(req) ?? "";

export type ListenerOptions = {
  hostname: string;
  port: number;
  maxRequestBodySize: number;
  idleTimeout: number;
  certStore: CertStore;
  deps: DispatchDeps;
  onError?: (e: Error) => void;
};

export type RunningListener = {
  readonly port: number;
  readonly hostname: string;
  stop(closeActive?: boolean): void;
  pending(): { requests: number; webSockets: number };
  /** Rebinds with fresh certificate material. See swapCerts below. */
  swapCerts(): void;
};

export function startListener(o: ListenerOptions): RunningListener {
  const serveOptions = () => ({
    hostname: o.hostname,
    port: o.port,
    // SO_REUSEPORT is what makes the certificate swap possible -- see swapCerts.
    reusePort: true,
    tls: o.certStore.tlsConfig(),
    maxRequestBodySize: o.maxRequestBodySize,
    idleTimeout: o.idleTimeout,
    // Never leak a stack trace: preview visitors are untrusted.
    development: false,

    fetch(req: Request, server: Server<WsData>): Response | Promise<Response> | undefined {
      peers.set(req, server.requestIP(req)?.address ?? "");
      // A WebSocket upgrade must be taken BEFORE dispatch, because Bun owns the socket
      // from the moment server.upgrade() succeeds and no Response may be returned.
      if (isWebSocketUpgrade(req)) {
        const host = normalizeHost(req.headers.get("host"));
        const label = host === null ? null : labelUnder(host, o.deps.baseDomain());
        if (host && label !== null && label !== "" && !RESERVED_LABELS.has(label)) {
          const entry = o.deps.table.lookup(host);
          if (entry && entry.state === "awake") {
            const gated = o.deps.visibilityGate?.(entry, req);
            if (!gated) {
              const url = new URL(req.url);
              const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
              const data: WsData = {
                entry,
                path: url.pathname + url.search,
                protocol,
                cookie: req.headers.get("cookie") ?? undefined,
              };
              // Echo the negotiated subprotocol or the client may abort the handshake.
              const ok = protocol
                ? server.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": protocol } })
                : server.upgrade(req, { data });
              if (ok) return undefined;
            }
          }
        }
      }

      // SSE and slow uploads must outlive the per-request idle timeout. Spike S0/P2
      // proved a stream held 12.1s against a 10s idleTimeout once this is set.
      server.timeout(req, 0);
      return dispatch(req, o.deps);
    },

    websocket: wsRelay,

    error(e: Error): Response {
      o.onError?.(e);
      return new Response("internal error", { status: 500 });
    },
  });

  let server = Bun.serve<WsData>(serveOptions() as never);

  return {
    get port() { return server.port ?? o.port; },
    get hostname() { return o.hostname; },

    /**
     * Certificate hot-swap.
     *
     * Spike S0/P6 established that `server.reload({ tls })` does NOT replace the
     * certificate on Bun 1.4.2 -- new connections still presented the old serial. So we
     * bind a SECOND listener on the same port with SO_REUSEPORT carrying the new
     * material, then stop the old one WITHOUT closing its active connections, letting
     * in-flight requests drain on the old context. Measured 12-18ms, with an in-flight
     * SSE stream surviving intact.
     */
    swapCerts() {
      const old = server;
      server = Bun.serve<WsData>(serveOptions() as never);
      old.stop(false);
    },

    /** In-flight HTTP requests (streams included) and open WebSockets, for the shutdown drain. */
    pending() {
      return { requests: server.pendingRequests, webSockets: server.pendingWebSockets };
    },

    /** `false` stops accepting and lets active connections finish; `true` closes them. */
    stop(closeActive = true) {
      void server.stop(closeActive);
    },
  };
}
