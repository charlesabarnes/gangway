import type { Actor } from "../auth/actor.ts";
import type { Surface } from "../net/dispatch.ts";

export type AppEnv = {
  Bindings: { surface: Surface; clientIp: string };
  Variables: { requestId: string; actor: Actor };
};
