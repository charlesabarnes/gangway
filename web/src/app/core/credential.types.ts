// API tokens, OAuth consent and connected agents, and where a credential may set secrets.
import type { Permission, Scope } from './api.types';

/** Where a credential with the secrets scope may set them; null when it is not narrowed. */
export type SecretTargets = {
  previews: 'own' | 'all';
  projects: 'all' | string[];
  org: boolean;
};
export const DEFAULT_SECRET_TARGETS: SecretTargets = { previews: 'own', projects: [], org: false };

export type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  secretTargets: SecretTargets | null;
  userId: string | null;
  appName: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type OAuthScope =
  'read' | 'deploy' | 'update' | 'artifacts' | 'projects' | 'themes' | 'secrets';
export type ConsentRequest = {
  id: string;
  client: { id: string; name: string; host: string };
  redirectUri: string;
  redirectHost: string;
  resource: string;
  requested: OAuthScope[];
  /** What was asked for, then any narrower stand-in the person may pick instead. */
  offered: OAuthScope[];
  grantable: OAuthScope[];
  scopePermissions: Record<OAuthScope, Permission[]>;
  expiresAt: string;
};
export type OAuthGrant = {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: OAuthScope[];
  secretTargets: SecretTargets | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
};
