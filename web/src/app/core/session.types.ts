import type { Permission, Scope } from './api.types';

export type SessionUser = { id: string; email: string; role: { id: string; name: string } };

/** The session before anyone signs in: what the login page may offer. */
export type AnonymousSession = {
  authenticated: false;
  setupRequired: boolean;
  passwordReset?: boolean;
  /** An identity provider people sign in with, named by its button. */
  oidc?: { label: string } | null;
  /** False when only the identity provider signs people in. */
  passwords?: boolean;
};

export type SessionInfo =
  | AnonymousSession
  | {
      authenticated: true;
      setupRequired: false;
      user?: SessionUser;
      token?: { id: string; scopes: Scope[] };
      permissions: Permission[];
    };

export type LoginResponse = { user: SessionUser; permissions: Permission[] };
