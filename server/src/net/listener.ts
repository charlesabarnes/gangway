/**
 * The single TLS listener: one socket, dispatched on the Host header. `Bun.serve` rather than
 * node:tls with an SNI callback, so the preview proxy is just another fetch handler.
 */
import type { Server } from "bun";
import type { CertStore } from "../tls/certstore.ts";
import { dispatch, type DispatchDeps } from "./dispatch.ts";
import { stripGangwayCookies } from "./gate.ts";
import { isWebSocketUpgrade } from "./headers.ts";
import { labelUnder, normalizeHost, RESERVED_LABELS } from "@gangway/shared/hostname";
import { wsRelay, type WsData } from "./ws-relay.ts";

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
      // A WebSocket upgrade must be taken before dispatch, because Bun owns the socket
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
                // The same stripping the HTTP leg does: the gate cookie stops here.
                cookie: stripGangwayCookies(req.headers.get("cookie")) ?? undefined,
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

      // SSE and slow uploads must outlive the per-request idle timeout.
      server.timeout(req, 0);
      return dispatch(req, o.deps);
    },

    websocket: wsRelay,

    error(e: Error): Response {
      o.onError?.(e);
      return new Response("internal error", { status: 500 });
    },
  });

  let server = Bun.serve<WsData>(serveOptions());

  return {
    get port() {
      return server.port ?? o.port;
    },
    get hostname() {
      return o.hostname;
    },

    /**
     * Certificate hot-swap. `server.reload({ tls })` does not replace the certificate, so this
     * binds a second listener on the same port (SO_REUSEPORT) with the new material, then stops
     * the old one without closing its active connections so in-flight requests drain.
     */
    swapCerts() {
      const old = server;
      server = Bun.serve<WsData>(serveOptions());
      void old.stop(false);
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
