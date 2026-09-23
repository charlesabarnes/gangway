import type { Hono } from "hono";
import { AuditQuerySchema } from "@gangway/shared/api";
import type { AuditRepo } from "../../db/repos/audit.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export function auditRoutes(api: Hono<AppEnv>, audit: AuditRepo): void {
  api.get("/audit", requirePermission("audit.read"), (c) => {
    const { before, limit, action } = AuditQuerySchema.parse(c.req.query());
    return c.json(
      audit.page({
        limit,
        ...(before === undefined ? {} : { before }),
        ...(action === undefined ? {} : { action }),
      }),
    );
  });
}
