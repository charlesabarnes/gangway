import type { Permission } from "@gangway/shared/permissions";
import { can, type Actor } from "../auth/actor.ts";

// Any one of a tool's permissions lets it be called; the first is the one a refusal names.
export const TOOL_PERMISSIONS = {
  deploy: ["previews.deploy", "previews.deploy_static"],
  status: ["previews.read", "previews.read_own"],
  logs: ["logs.read", "previews.read_own"],
  destroy: ["previews.destroy", "previews.destroy_own"],
  catalog: ["previews.read", "previews.read_own"],
} as const satisfies Record<string, readonly Permission[]>;
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

export function need(actor: Actor, ...ps: readonly [Permission, ...Permission[]]): void {
  if (!ps.some((p) => can(actor, p))) throw new MissingPermission(ps[0]);
}
