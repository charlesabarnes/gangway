---
title: Single sign-on
description: Sign people in to gangway through an OpenID Connect provider such as Authentik, Keycloak or Google.
---

gangway can sign people in through an OpenID Connect provider: Authentik, Keycloak, Google
Workspace, Okta and others. The provider proves who someone is. gangway still
decides who gets in: only accounts an admin added under **Admin → Users** can sign in, and their
role decides what they may do. Signing in never creates an account.

## Set it up

1. At the provider, create an OpenID Connect client (often called an "application" or "web
   app"). It is a confidential client with the authorization code flow.
2. Give it this redirect URI, exactly, with your own app address:

   ```
   https://app.<your domain>/v1/auth/oidc/callback
   ```

   **Admin → Server → Single sign-on** shows the exact value for your server.

3. Copy the issuer URL, the client id and the client secret into **Admin → Server → Single
   sign-on**, or set them as environment variables:

   ```sh
   GANGWAY_OIDC_ISSUER=https://auth.example.com/application/o/gangway/
   GANGWAY_OIDC_CLIENT_ID=...
   GANGWAY_OIDC_CLIENT_SECRET=...
   GANGWAY_OIDC_LABEL="Sign in with Example"   # the button's text
   ```

4. Add people under **Admin → Users** with **Signs in with …**. Their email address at gangway
   must be the one the provider reports.

The login page now shows the button. The first time someone signs in, gangway matches them by
their verified email and remembers the provider's id for them, so a later change of email at the
provider still finds the same account.

gangway asks for the `openid email profile` scopes, uses PKCE, and checks the ID token's
signature (RS256 or ES256), issuer, audience, expiry and nonce. The provider must report the email
address as verified (`email_verified: true`).

## Turn passwords off

With single sign-on working, you can turn off **Also allow sign-in with a password**, or set
`GANGWAY_PASSWORD_LOGIN=false`. Password login, password resets and first passwords for new users
are then refused, and the login page shows only the provider's button. The one exception is the
first admin made on the setup page, who still sets a password, since nobody can sign in yet. Inviting someone by email still
works: they get a note that says where to sign in.

gangway refuses to turn passwords off while the provider is not fully set up. If the provider's
settings are removed later, passwords count as on again, so nobody is locked out.

API tokens, including `GANGWAY_ADMIN_TOKEN`, keep working either way.

## Provider notes

**Authentik.** Create an OAuth2/OpenID provider (confidential), set the redirect URI, then an
application that uses it. The issuer is
`https://<authentik>/application/o/<application slug>/`.

**Keycloak.** Create a client with **Client authentication** on and **Standard flow** on, and add
the redirect URI under **Valid redirect URIs**. The issuer is
`https://<keycloak>/realms/<realm>`.

**Google Workspace.** In Google Cloud, create an OAuth client of type **Web application** and add
the redirect URI. The issuer is `https://accounts.google.com`. Anyone with a Google account can
complete Google's side, so only the accounts you add in gangway get in.

**Microsoft Entra.** Entra's ID tokens carry no `email_verified` claim, so gangway refuses them
for now. Put a provider that does report it, such as Authentik or Keycloak, in front of Entra.
