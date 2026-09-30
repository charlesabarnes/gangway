import type { Hono } from "hono";
import { can, maySee, type Actor, type Provenance } from "../../auth/actor.ts";
import type { EventBus } from "../../events/bus.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { resumeCursor, sse, type SseOptions } from "../sse.ts";

export type EventRouteDeps = { provenanceOf: (previewId: string) => Provenance };

/** Whether the actor may see a preview's events; each preview's answer is kept for the stream. */
function seesEventsOf(actor: Actor, d: EventRouteDeps): (previewId: string | null) => boolean {
  if (can(actor, "previews.read")) {
    return () => true;
  }
  const seen = new Map<string, boolean>();
  return (id) => {
    if (id === null) {
      return true;
    }
    let ok = seen.get(id);
    if (ok === undefined) {
      seen.set(id, (ok = maySee(actor, d.provenanceOf(id))));
    }
    return ok;
  };
}

export function eventRoutes(
  api: Hono<AppEnv>,
  bus: EventBus,
  d: EventRouteDeps,
  o: SseOptions = {},
): void {
  api.get("/events", requirePermission("events.read"), (c) => {
    const after = resumeCursor(c);
    const sees = seesEventsOf(c.get("actor"), d);
    return sse(
      c,
      (push) =>
        bus.follow(after, (e) => {
          if (!sees(e.previewId)) {
            return;
          }
          push({
            id: String(e.seq),
            event: e.type,
            data: JSON.stringify({
              previewId: e.previewId,
              at: e.createdAt.toISOString(),
              ...e.payload,
            }),
          });
        }),
      o,
    );
  });
}
