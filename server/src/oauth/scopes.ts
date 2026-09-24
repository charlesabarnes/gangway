import type { Scope } from "@gangway/shared/permissions";

export const OAUTH_SCOPES = [
  "read",
  "deploy",
  "update",
  "artifacts",
] as const satisfies readonly Scope[];
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

// Agents ask for what they know to ask for; the person may hand over something narrower instead.
const NARROWER: Partial<Record<OAuthScope, readonly OAuthScope[]>> = { deploy: ["artifacts"] };

/** What the consent screen offers: what was asked for, then any narrower stand-in for it. */
export function offeredScopes(requested: readonly OAuthScope[]): OAuthScope[] {
  const extra = requested.flatMap((s) => NARROWER[s] ?? []);
  return [...new Set([...requested, ...extra])];
}
