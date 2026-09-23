/**
 * Push-source -> SSE. The sources (event bus, preview logs) deliver synchronously; an SSE
 * write is async and a client can be arbitrarily slow. So: a bounded queue between them,
 * and a client that falls too far behind is disconnected rather than buffered without
 * limit -- it reconnects with Last-Event-ID and replays from the durable copy.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "./env.ts";

export type SseMessage = { id: string; event: string; data: string };

export type SseSource = (push: (m: SseMessage) => void) => () => void;

export type SseOptions = {
  heartbeatMs?: number;
  maxQueue?: number;
  /** Shutdown. A stream never ends on its own, so a graceful stop has to end it. */
  signal?: AbortSignal | undefined;
};

/**
 * How far behind a client may fall before it is disconnected. A source that REPLAYS on
 * subscribe must deliver fewer than this synchronously, or the stream closes before its
 * first frame (previews/logs.ts bounds its replay for exactly this reason).
 */
export const SSE_MAX_QUEUE = 5_000;

/** `Last-Event-ID` from a reconnecting EventSource, or `?after=` for curl. */
export function resumeCursor(c: Context<AppEnv>): number {
  const raw = c.req.header("last-event-id") ?? c.req.query("after") ?? "0";
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function sse(c: Context<AppEnv>, source: SseSource, o: SseOptions = {}): Response {
  const heartbeatMs = o.heartbeatMs ?? 15_000;
  const maxQueue = o.maxQueue ?? SSE_MAX_QUEUE;

  const res = streamSSE(c, async (stream) => {
    const queue: SseMessage[] = [];
    let wake: (() => void) | null = null;
    let open = true;

    const close = () => {
      open = false;
      wake?.();
    };
    const unsubscribe = source((m) => {
      if (queue.length >= maxQueue) return close();
      queue.push(m);
      wake?.();
    });
    stream.onAbort(close);
    // The client reconnects with Last-Event-ID and misses nothing: both sources are durable.
    o.signal?.addEventListener("abort", close, { once: true });
    if (o.signal?.aborted) close();

    try {
      // Say something at once. An idle stream otherwise sends no BODY byte until its first
      // event or heartbeat, and an intermediary may sit on the response headers until it
      // has one -- so the browser's `onopen` fires 15 seconds late and the UI says
      // "connecting" on a connection that is fine. Seen through the Angular dev proxy;
      // a comment line is invisible to EventSource and costs nothing.
      await stream.write(": connected\n\n");
      while (open) {
        const batch = queue.splice(0);
        for (const m of batch) await stream.writeSSE(m);
        if (!open || queue.length > 0) continue;
        const timedOut = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), heartbeatMs);
          wake = () => {
            clearTimeout(t);
            resolve(false);
          };
        });
        wake = null;
        // A comment line: keeps idle connections alive through NAT and lets us notice
        // a dead peer, without the client seeing an event.
        if (timedOut && open) await stream.write(": keepalive\n\n");
      }
    } finally {
      o.signal?.removeEventListener("abort", close);
      unsubscribe();
    }
  });
  // After streamSSE, which sets its own Cache-Control. A buffering intermediary would
  // otherwise hold the stream until it had "enough".
  res.headers.set("cache-control", "no-cache, no-transform");
  res.headers.set("x-accel-buffering", "no");
  return res;
}
