import type { Hono } from "hono";
import type { UpdateCheck } from "../../updates.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export function updateRoutes(api: Hono<AppEnv>, updates: Pick<UpdateCheck, "status">): void {
  api.get("/updates", requirePermission("settings.read"), (c) => c.json(updates.status()));
}
