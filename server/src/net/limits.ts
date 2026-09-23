/**
 * Per-preview resource caps: one preview must not exhaust the server.
 *
 * Counters live on the RouteEntry, so enforcement on the hot path is a field increment
 * rather than a map lookup into a rate-limiting library.
 */
import type { RouteEntry } from "../routing/table.ts";

export type Limits = {
  maxInflight: number;
  maxBodyBytes: number;
  maxBytesInFlight: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxInflight: 64,
  maxBodyBytes: 512 * 1024 * 1024,
  maxBytesInFlight: 1024 * 1024 * 1024,
};

export class BodyTooLarge extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLarge";
  }
}

export function tryAcquire(entry: RouteEntry, limits: Limits): boolean {
  if (entry.inflight >= limits.maxInflight) return false;
  if (entry.bytesInFlight >= limits.maxBytesInFlight) return false;
  entry.inflight++;
  return true;
}

export function release(entry: RouteEntry): void {
  if (entry.inflight > 0) entry.inflight--;
}

/**
 * Counts bytes as they stream and aborts past the cap.
 *
 * A TransformStream rather than a Content-Length check: a chunked upload declares no length,
 * so the only honest enforcement is to count what arrives and tear the request down mid-stream.
 */
export function capBody(
  body: ReadableStream<Uint8Array>,
  max: number,
  entry?: RouteEntry,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        seen += chunk.byteLength;
        if (entry) entry.bytesInFlight += chunk.byteLength;
        if (seen > max) {
          ctrl.error(new BodyTooLarge(max));
          return;
        }
        ctrl.enqueue(chunk);
      },
      flush() {
        if (entry) entry.bytesInFlight = Math.max(0, entry.bytesInFlight - seen);
      },
    }),
  );
}
