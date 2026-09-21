import type { Actor } from "../auth/actor.ts";
import type { Surface } from "../net/dispatch.ts";

/**
 * Bindings arrive from the dispatcher per request (`app.fetch(req, bindings)`); Variables
 * are set by middleware.
 */
export type AppEnv = {
  Bindings: { surface: Surface; clientIp: string };
  Variables: { requestId: string; actor: Actor };
};
