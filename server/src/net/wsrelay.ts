/**
 * WebSocket relay. This is a TERMINATION and RE-ORIGINATION, not a byte pipe: gangway
 * accepts the client's upgrade itself, then opens its own connection upstream. Spike S0
 * measured the fidelity that requires -- 1000 echoes, a 1 MiB frame, subprotocol
 * negotiation and close-code propagation in both directions.
 *
 * §6.4 warns this fails SILENTLY when wrong: HMR simply stops working and nothing logs.
 */
import type { ServerWebSocket } from "bun";
import type { RouteEntry } from "../routing/table.ts";

export type WsData = {
  entry: RouteEntry;
  path: string;
  protocol?: string | undefined;
  cookie?: string | undefined;
};

type Relay = { upstream: WebSocket; pending: (string | ArrayBuffer)[] };

const relays = new WeakMap<ServerWebSocket<WsData>, Relay>();

export const wsRelay = {
  maxPayloadLength: 16 * 1024 * 1024,
  idleTimeout: 300,

  open(ws: ServerWebSocket<WsData>) {
    const { entry, path, protocol, cookie } = ws.data;
    const url = `ws://${entry.upstreamHost}:${entry.upstreamPort}${path}`;
    const headers: Record<string, string> = { host: entry.hostname };
    if (cookie) headers["cookie"] = cookie;

    const upstream = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
    upstream.binaryType = "arraybuffer";

    const relay: Relay = { upstream, pending: [] };
    relays.set(ws, relay);

    // Frames can arrive before the upstream finishes connecting; buffer, then flush.
    upstream.onopen = () => {
      for (const m of relay.pending) upstream.send(m as string);
      relay.pending.length = 0;
    };
    upstream.onmessage = (ev) => {
      try {
        ws.send(ev.data as string | ArrayBuffer);
      } catch {
        /* client gone */
      }
    };
    upstream.onclose = (ev) => {
      // 1005 means "no status received" and may not be sent on the wire.
      try {
        ws.close(ev.code === 1005 ? 1000 : ev.code, ev.reason);
      } catch {
        /* already closed */
      }
    };
    upstream.onerror = () => {
      try {
        ws.close(1011, "upstream error");
      } catch {
        /* already closed */
      }
    };
  },

  message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
    const relay = relays.get(ws);
    if (!relay) return;
    const payload =
      typeof msg === "string"
        ? msg
        : msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
    if (relay.upstream.readyState === WebSocket.OPEN) {
      relay.upstream.send(payload as string);
    } else {
      relay.pending.push(payload as string | ArrayBuffer);
    }
  },

  close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
    const relay = relays.get(ws);
    if (!relay) return;
    // 1005/1006 are local-only codes and must not be forwarded verbatim.
    const out = code === 1005 || code === 1006 ? 1000 : code;
    try {
      relay.upstream.close(out, reason);
    } catch {
      /* already closed */
    }
    relays.delete(ws);
  },
};
