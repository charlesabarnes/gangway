import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "./env.ts";

export type SseMessage = { id: string; event: string; data: string };

export type SseSource = (push: (m: SseMessage) => void) => () => void;

export type SseOptions = {
  heartbeatMs?: number;
  maxQueue?: number;
  signal?: AbortSignal | undefined;
};

// A source that replays on subscribe must deliver fewer than this synchronously, or the stream closes before its first frame.
export const SSE_MAX_QUEUE = 5_000;

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
    o.signal?.addEventListener("abort", close, { once: true });
    if (o.signal?.aborted) close();

    try {
      // Some proxies hold response headers until the first body byte, delaying onopen until the first heartbeat.
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
        if (timedOut && open) await stream.write(": keepalive\n\n");
      }
    } finally {
      o.signal?.removeEventListener("abort", close);
      unsubscribe();
    }
  });
  // Set after streamSSE, which sets its own Cache-Control.
  res.headers.set("cache-control", "no-cache, no-transform");
  res.headers.set("x-accel-buffering", "no");
  return res;
}
