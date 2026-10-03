import { randomBytes } from "node:crypto";
import { Accounts } from "../auth/accounts.ts";
import { Bootstrap } from "../auth/bootstrap.ts";
import { EmailLinks } from "../auth/links.ts";
import { LoginLimiter } from "../auth/limiter.ts";
import { Passwords } from "../auth/password.ts";
import { RolePermissions } from "../auth/roles.ts";
import { Sessions } from "../auth/sessions.ts";
import { Sso } from "../auth/sso.ts";
import { Tokens } from "../auth/tokens.ts";
import { Mailer } from "../mail/mailer.ts";
import { SETTINGS } from "../settings.ts";
import { ClientMetadataStore } from "../oauth/client-metadata.ts";
import { ClientRegistry, clientResolver } from "../oauth/client-registration.ts";
import { OAuthServer } from "../oauth/server.ts";
import type { Core } from "./core.ts";

export type Identity = {
  roles: RolePermissions;
  sessions: Sessions;
  oauth: OAuthServer;
  accounts: Accounts;
  tokens: Tokens;
  bootstrap: Bootstrap;
  mailer: Mailer;
  links: EmailLinks;
  sso: Sso;
  /** False only while an identity provider is set up and password sign-in is turned off. */
  passwords: () => boolean;
};

export function createIdentity({ db, repos, audit, origin, settings, logger }: Core): Identity {
  const roles = new RolePermissions(repos.roles, audit);
  const sessions = new Sessions(repos.sessions, roles);
  const registry = new ClientRegistry(repos.oauthClients);
  const oauth = new OAuthServer({
    grants: repos.oauthGrants,
    clients: clientResolver(registry, new ClientMetadataStore()),
    registry,
    roles,
    audit,
    issuer: () => origin("app"),
    resource: () => origin("mcp"),
  });
  const passwords = new Passwords();
  // A new password or a disabled account also kills any emailed link still outstanding.
  const onCredentialsRevoked = (userId: string) => {
    oauth.revokeAllFor(userId);
    repos.userLinks.deleteForUser(userId);
  };
  const accounts = new Accounts({
    db,
    users: repos.users,
    identities: repos.userIdentities,
    roles: repos.roles,
    sessions,
    audit,
    passwords,
    limiter: new LoginLimiter(),
    onCredentialsRevoked,
  });
  const mailer = new Mailer({
    url: () => settings.get(SETTINGS.mailSmtpUrl),
    from: () => settings.get(SETTINGS.mailFrom),
  });
  const links = new EmailLinks({
    db,
    users: repos.users,
    links: repos.userLinks,
    sessions,
    passwords,
    mailer,
    audit,
    limiter: new LoginLimiter({ emailFree: 1, ipMax: 10 }),
    appOrigin: () => origin("app"),
    logger: logger.child({ mod: "mail" }),
    onCredentialsRevoked,
  });
  const tokens = new Tokens(repos.tokens, roles, audit);
  const bootstrap = new Bootstrap(() => repos.users.count());
  const sso = new Sso({
    config: () => {
      const issuer = settings.get(SETTINGS.oidcIssuer);
      const clientId = settings.get(SETTINGS.oidcClientId);
      const clientSecret = settings.get(SETTINGS.oidcClientSecret);
      return issuer === "" || clientId === "" || clientSecret === ""
        ? null
        : { issuer, clientId, clientSecret, label: settings.get(SETTINGS.oidcLabel) };
    },
    redirectUri: () => `${origin("app")}/v1/auth/oidc/callback`,
    logger: logger.child({ mod: "sso" }),
  });
  // Off counts only while the provider is set up, so a half-finished setup never locks anyone out.
  const passwordLogin = () => settings.get(SETTINGS.passwordLogin) || !sso.configured;
  return {
    roles,
    sessions,
    oauth,
    accounts,
    tokens,
    bootstrap,
    mailer,
    links,
    sso,
    passwords: passwordLogin,
  };
}

export function resolveAdminToken(
  configured: string | undefined,
  announce: (text: string) => void,
): string {
  if (configured) {
    return configured;
  }
  const adminToken = `gw_${randomBytes(24).toString("base64url")}`;
  announce(
    `\n  No GANGWAY_ADMIN_TOKEN is set. Generated one for THIS RUN ONLY:\n\n    ${adminToken}\n`,
  );
  return adminToken;
}
