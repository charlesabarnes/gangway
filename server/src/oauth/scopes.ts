import type { Scope } from "@gangway/shared/permissions";

export const OAUTH_SCOPES = ["read", "deploy", "update"] as const satisfies readonly Scope[];
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
