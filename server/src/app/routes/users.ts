import type { Hono } from "hono";
import { CreateUserSchema, UpdateUserSchema } from "@gangway/shared/api";
import type { Accounts } from "../../auth/accounts.ts";
import type { EmailLinks } from "../../auth/links.ts";
import type { Sso } from "../../auth/sso.ts";
import { conflict, errorMessage, notFound } from "../../errors.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

const NO_MAIL = "email is not set up on this server; give a first password instead";
const NO_SSO = "sign-in with an identity provider is not set up on this server";
const NO_PASSWORDS = "password sign-in is off on this server; add them with sso: true instead";

export type UserRouteSso = {
  sso?: Sso | undefined;
  /** False only while an identity provider is set up and password sign-in is turned off. */
  passwords?: (() => boolean) | undefined;
};

export function userRoutes(
  api: Hono<AppEnv>,
  accounts: Accounts,
  links?: EmailLinks,
  o: UserRouteSso = {},
): void {
  const passwordsOn = () => o.passwords?.() ?? true;
  const ssoLabel = () => (o.sso?.configured ? o.sso.label() : null);

  api.get("/users", requirePermission("users.read"), (c) =>
    c.json({
      users: accounts.listUsers(),
      email: links?.available === true,
      sso: ssoLabel() === null ? null : { label: ssoLabel() },
      // Whether people may sign in with a password here (named so no field reads "password").
      localLogin: passwordsOn(),
    }),
  );

  api.post("/users", requirePermission("users.manage"), async (c) => {
    const body = await readJson(c);
    const { email, roleId, password, sso } = CreateUserSchema.parse(body);
    const label = ssoLabel();
    if (sso === true && label === null) {
      throw conflict(NO_SSO);
    }
    if (password !== undefined && !passwordsOn()) {
      throw conflict(NO_PASSWORDS);
    }
    const invite = password === undefined && sso === undefined;
    if (invite && !links?.available) {
      throw conflict(NO_MAIL);
    }
    const actor = c.get("actor");
    // With passwords off an invitation has nothing to choose: it is an SSO account plus a note.
    const ssoOnly = sso === true || (invite && !passwordsOn());
    const user = await accounts.createUser(actor, {
      email,
      roleId,
      password,
      ...(ssoOnly ? { sso: true } : {}),
    });
    if (!invite || !links) {
      return c.json({ user }, 201);
    }
    // The account exists either way; a failed send is reported, and the list offers a resend.
    const send =
      ssoOnly && label !== null
        ? links.sendSsoNotice(actor, user, label)
        : links.sendFor(actor, user);
    const error = await send.then(
      () => undefined,
      (e: unknown) => errorMessage(e),
    );
    return c.json(
      { user, invite: error === undefined ? { sent: true } : { sent: false, error } },
      201,
    );
  });

  api.patch("/users/:id", requirePermission("users.manage"), async (c) => {
    const body = await readJson(c);
    const { roleId, disabled, password } = UpdateUserSchema.parse(body);
    if (password !== undefined && !passwordsOn()) {
      throw conflict("password sign-in is off on this server");
    }
    const user = await accounts.updateUser(c.get("actor"), c.req.param("id"), {
      ...(roleId === undefined ? {} : { roleId }),
      ...(disabled === undefined ? {} : { disabled }),
      ...(password === undefined ? {} : { password }),
    });
    return c.json({ user });
  });

  emailLinkRoute(api, accounts, links, () => (passwordsOn() ? null : ssoLabel()));
}

// An admin's resend. With passwords off (ssoOnly names the provider) it says where to sign in.
function emailLinkRoute(
  api: Hono<AppEnv>,
  accounts: Accounts,
  links: EmailLinks | undefined,
  ssoOnly: () => string | null,
): void {
  api.post("/users/:id/email-link", requirePermission("users.manage"), async (c) => {
    if (!links?.available) {
      throw conflict(NO_MAIL);
    }
    const id = c.req.param("id");
    const user = accounts.getUser(id);
    if (!user) {
      throw notFound(`no such user: ${id}`);
    }
    const label = ssoOnly();
    if (label !== null) {
      await links.sendSsoNotice(c.get("actor"), user, label);
      return c.json({ sent: "sso" });
    }
    return c.json({ sent: await links.sendFor(c.get("actor"), user) });
  });
}
