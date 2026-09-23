/**
 * ADR-0015: the runtime catalogue, for the New preview screen. The detection rules travel
 * with it, so the UI's guess and the server's choice are the same function over the same data.
 */
import type { Hono } from "hono";
import { DETECTION, RUNTIMES } from "../../../../shared/src/runtimes.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export function runtimeRoutes(api: Hono<AppEnv>): void {
  const body = {
    runtimes: RUNTIMES.map(({ id, name, language, description, image, port, starter }) => ({ id, name, language, description, image, port, starter })),
    detection: DETECTION,
  };
  api.get("/runtimes", requirePermission("previews.read"), (c) => c.json(body));
}
