import type { Hono } from "hono";
import { CreateTokenSchema } from "@gangway/shared/api";
import type { Tokens } from "../../auth/tokens.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export function tokenRoutes(api: Hono<AppEnv>, tokens: Tokens): void {
  api.get("/tokens", requirePermission("tokens.manage_own"), (c) =>
    c.json({ tokens: tokens.list(c.get("actor"), { all: c.req.query("all") === "true" }) }),
  );

  api.post("/tokens", requirePermission("tokens.manage_own"), async (c) => {
    const body = await readJson(c);
    const { token, secret } = tokens.mint(c.get("actor"), CreateTokenSchema.parse(body));
    c.header("cache-control", "no-store");
    return c.json({ token, secret }, 201);
  });

  api.delete("/tokens/:id", requirePermission("tokens.manage_own"), (c) =>
    c.json({ token: tokens.revoke(c.get("actor"), c.req.param("id")) }),
  );
}
