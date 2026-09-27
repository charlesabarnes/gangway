import type { Hono } from "hono";
import { CreateUserSchema, UpdateUserSchema } from "@gangway/shared/api";
import type { Accounts } from "../../auth/accounts.ts";
import type { EmailLinks } from "../../auth/links.ts";
import { conflict, errorMessage, notFound } from "../../errors.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

const NO_MAIL = "email is not set up on this server; give a first password instead";

export function userRoutes(api: Hono<AppEnv>, accounts: Accounts, links?: EmailLinks): void {
  api.get("/users", requirePermission("users.read"), (c) =>
    c.json({ users: accounts.listUsers(), email: links?.available === true }),
  );

  api.post("/users", requirePermission("users.manage"), async (c) => {
    const body = await readJson(c);
    const { email, roleId, password } = CreateUserSchema.parse(body);
    const invite = password === undefined;
    if (invite && !links?.available) throw conflict(NO_MAIL);
    const actor = c.get("actor");
    const user = await accounts.createUser(actor, { email, roleId, password });
    if (!invite || !links) return c.json({ user }, 201);
    // The account exists either way; a failed send is reported, and the list offers a resend.
    const error = await links.sendFor(actor, user).then(
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
    const user = await accounts.updateUser(c.get("actor"), c.req.param("id"), {
      ...(roleId === undefined ? {} : { roleId }),
      ...(disabled === undefined ? {} : { disabled }),
      ...(password === undefined ? {} : { password }),
    });
    return c.json({ user });
  });

  api.post("/users/:id/email-link", requirePermission("users.manage"), async (c) => {
    if (!links?.available) throw conflict(NO_MAIL);
    const id = c.req.param("id");
    const user = accounts.getUser(id);
    if (!user) throw notFound(`no such user: ${id}`);
    return c.json({ sent: await links.sendFor(c.get("actor"), user) });
  });
}
