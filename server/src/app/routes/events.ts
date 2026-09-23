import type { Hono } from "hono";
import type { EventBus } from "../../events/bus.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { resumeCursor, sse, type SseOptions } from "../sse.ts";

/** `GET /v1/events`: the global state stream, over SSE. */
export function eventRoutes(api: Hono<AppEnv>, bus: EventBus, o: SseOptions = {}): void {
  api.get("/events", requirePermission("events.read"), (c) => {
    const after = resumeCursor(c);
    return sse(
      c,
      (push) =>
        bus.follow(after, (e) =>
          push({
            id: String(e.seq),
            event: e.type,
            data: JSON.stringify({
              previewId: e.previewId,
              at: e.createdAt.toISOString(),
              ...e.payload,
            }),
          }),
        ),
      o,
    );
  });
}
