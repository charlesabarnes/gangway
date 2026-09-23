import type { Hono } from "hono";
import { CreateUserSchema, UpdateUserSchema } from "@gangway/shared/api";
import type { Accounts } from "../../auth/accounts.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export function userRoutes(api: Hono<AppEnv>, accounts: Accounts): void {
  api.get("/users", requirePermission("users.read"), (c) =>
    c.json({ users: accounts.listUsers() }),
  );

  api.post("/users", requirePermission("users.manage"), async (c) => {
    const body = await readJson(c);
    return c.json(
      { user: await accounts.createUser(c.get("actor"), CreateUserSchema.parse(body)) },
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
}
