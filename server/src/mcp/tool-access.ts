import type { Permission } from "@gangway/shared/permissions";
import { can, type Actor } from "../auth/actor.ts";

export const TOOL_PERMISSIONS = {
  deploy: "previews.deploy",
  status: "previews.read",
  logs: "logs.read",
  destroy: "previews.destroy",
  catalog: "previews.read",
} as const satisfies Record<string, Permission>;
export type ToolName = keyof typeof TOOL_PERMISSIONS;
export const REDEPLOY_PERMISSION: Permission = "previews.update";
export const REDEPLOY_OWN_PERMISSION: Permission = "previews.update_own";

export class MissingPermission extends Error {
  readonly permission: Permission;
  constructor(permission: Permission, why?: string) {
    super(`this credential lacks the "${permission}" permission${why ? `: ${why}` : ""}`);
    this.permission = permission;
  }
}

export function need(actor: Actor, p: Permission): void {
  if (!can(actor, p)) throw new MissingPermission(p);
}
