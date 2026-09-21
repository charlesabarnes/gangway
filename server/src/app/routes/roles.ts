import type { Hono } from "hono";
import { SetRolePermissionsSchema } from "../../../../shared/src/api.ts";
import { PERMISSIONS } from "../../../../shared/src/permissions.ts";
import type { RolePermissions } from "../../auth/roles.ts";
import { badRequest } from "../../errors.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

/**
 * `/v1/roles` (ADR-0009): what each role may do, and the one call that changes it.
 *
 *   curl -X PUT $API/v1/roles/viewer/permissions -H "Authorization: Bearer $TOKEN" \
 *     -H 'content-type: application/json' -d '{"permissions":["previews.read","logs.read"]}'
 *
 * A PUT of the COMPLETE set, not a patch: what is sent is what the role holds afterwards,
 * so the request can be read on its own. `catalogue` is everything that can be granted.
 */
export function roleRoutes(api: Hono<AppEnv>, roles: RolePermissions): void {
  api.get("/roles", requirePermission("roles.read"), (c) => c.json({ roles: roles.roles(), catalogue: PERMISSIONS }));

  api.put("/roles/:id/permissions", requirePermission("roles.manage"), async (c) => {
    const body = await c.req.json().catch(() => { throw badRequest("the request body is not JSON"); });
    const { permissions } = SetRolePermissionsSchema.parse(body);
    roles.set(c.req.param("id"), permissions, c.get("actor"));
    return c.json({ role: roles.roles().find((r) => r.id === c.req.param("id")) });
  });
}
