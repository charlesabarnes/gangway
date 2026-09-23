import type { Hono } from "hono";
import { SetRolePermissionsSchema } from "@gangway/shared/api";
import { PERMISSIONS } from "@gangway/shared/permissions";
import type { RolePermissions } from "../../auth/roles.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export function roleRoutes(api: Hono<AppEnv>, roles: RolePermissions): void {
  api.get("/roles", requirePermission("roles.read"), (c) =>
    c.json({ roles: roles.roles(), catalogue: PERMISSIONS }),
  );

  api.put("/roles/:id/permissions", requirePermission("roles.manage"), async (c) => {
    const body = await readJson(c);
    const { permissions } = SetRolePermissionsSchema.parse(body);
    roles.set(c.req.param("id"), permissions, c.get("actor"));
    return c.json({ role: roles.roles().find((r) => r.id === c.req.param("id")) });
  });
}
