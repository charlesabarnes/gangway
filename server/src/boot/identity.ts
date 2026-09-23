import { randomBytes } from "node:crypto";
import { Accounts } from "../auth/accounts.ts";
import { Bootstrap } from "../auth/bootstrap.ts";
import { LoginLimiter } from "../auth/limiter.ts";
import { Passwords } from "../auth/password.ts";
import { RolePermissions } from "../auth/roles.ts";
import { Sessions } from "../auth/sessions.ts";
import { Tokens } from "../auth/tokens.ts";
import { ClientMetadataStore } from "../oauth/client-metadata.ts";
import { OAuthServer } from "../oauth/server.ts";
import type { Core } from "./core.ts";

export type Identity = {
  roles: RolePermissions;
  sessions: Sessions;
  oauth: OAuthServer;
  accounts: Accounts;
  tokens: Tokens;
  bootstrap: Bootstrap;
};

export function createIdentity({ db, repos, audit, origin }: Core): Identity {
  const roles = new RolePermissions(repos.roles, audit);
  const sessions = new Sessions(repos.sessions, roles);
  const oauth = new OAuthServer({
    grants: repos.oauthGrants,
    clients: new ClientMetadataStore(),
    roles,
    audit,
    issuer: () => origin("app"),
    resource: () => origin("mcp"),
  });
  const accounts = new Accounts({
    db,
    users: repos.users,
    roles: repos.roles,
    sessions,
    audit,
    passwords: new Passwords(),
    limiter: new LoginLimiter(),
    onCredentialsRevoked: (userId) => oauth.revokeAllFor(userId),
  });
  const tokens = new Tokens(repos.tokens, roles, audit);
  const bootstrap = new Bootstrap(() => repos.users.count());
  return { roles, sessions, oauth, accounts, tokens, bootstrap };
}

export function resolveAdminToken(
  configured: string | undefined,
  announce: (text: string) => void,
): string {
  if (configured) return configured;
  const adminToken = `gw_${randomBytes(24).toString("base64url")}`;
  announce(
    `\n  No GANGWAY_ADMIN_TOKEN is set. Generated one for THIS RUN ONLY:\n\n    ${adminToken}\n`,
  );
  return adminToken;
}
