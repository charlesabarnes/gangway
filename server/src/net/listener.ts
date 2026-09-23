import type { Server } from "bun";
import type { RouteEntry } from "../routing/table.ts";
import type { CertStore } from "../tls/certstore.ts";
import { dispatch, type DispatchDeps } from "./dispatch.ts";
import { stripGangwayCookies } from "./gate.ts";
import { isWebSocketUpgrade } from "./headers.ts";
import { labelUnder, normalizeHost, RESERVED_LABELS } from "@gangway/shared/hostname";
import { wsRelay, type WsData } from "./ws-relay.ts";

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
  swapCerts(): void;
};

function socketEntry(req: Request, deps: DispatchDeps): RouteEntry | null {
  const host = normalizeHost(req.headers.get("host"));
  const label = host === null ? null : labelUnder(host, deps.baseDomain());
  if (!host || label === null || label === "" || RESERVED_LABELS.has(label)) return null;
  const entry = deps.table.lookup(host);
  if (!entry || entry.state !== "awake") return null;
  return deps.visibilityGate?.(entry, req) ? null : entry;
}

function upgradeToPreview(req: Request, server: Server<WsData>, deps: DispatchDeps): boolean {
  const entry = socketEntry(req, deps);
  if (!entry) return false;
  const url = new URL(req.url);
  const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
  const data: WsData = {
    entry,
    path: url.pathname + url.search,
    protocol,
    cookie: stripGangwayCookies(req.headers.get("cookie")) ?? undefined,
  };
  return protocol
    ? server.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": protocol } })
    : server.upgrade(req, { data });
}

export function startListener(o: ListenerOptions): RunningListener {
  const serveOptions = () => ({
    hostname: o.hostname,
    port: o.port,
    // Needed by swapCerts.
    reusePort: true,
    tls: o.certStore.tlsConfig(),
    maxRequestBodySize: o.maxRequestBodySize,
    idleTimeout: o.idleTimeout,
    development: false,

    fetch(req: Request, server: Server<WsData>): Response | Promise<Response> | undefined {
      peers.set(req, server.requestIP(req)?.address ?? "");
      if (isWebSocketUpgrade(req) && upgradeToPreview(req, server, o.deps)) return undefined;

      // SSE and slow uploads must outlive the idle timeout.
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

    // server.reload({ tls }) does not replace the certificate, so bind a second listener and drain the old one.
    swapCerts() {
      const old = server;
      server = Bun.serve<WsData>(serveOptions());
      void old.stop(false);
    },

    pending() {
      return { requests: server.pendingRequests, webSockets: server.pendingWebSockets };
    },

    stop(closeActive = true) {
      void server.stop(closeActive);
    },
  };
}
