import type { Hono } from "hono";
import { CreateTokenSchema } from "../../../../shared/src/api.ts";
import type { Tokens } from "../../auth/tokens.ts";
import { badRequest } from "../../errors.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

/** §10.1 `/v1/tokens`. Thin (ADR-0003): who may touch WHICH token is decided in auth/tokens.ts. */
export function tokenRoutes(api: Hono<AppEnv>, tokens: Tokens): void {
  api.get("/tokens", requirePermission("tokens.manage_own"), (c) =>
    c.json({ tokens: tokens.list(c.get("actor"), { all: c.req.query("all") === "true" }) }));

  /** The only response that ever contains the secret. */
  api.post("/tokens", requirePermission("tokens.manage_own"), async (c) => {
    const body = await c.req.json().catch(() => { throw badRequest("the request body is not JSON"); });
    const { token, secret } = tokens.mint(c.get("actor"), CreateTokenSchema.parse(body));
    c.header("cache-control", "no-store");
    return c.json({ token, secret }, 201);
  });

  api.delete("/tokens/:id", requirePermission("tokens.manage_own"), (c) =>
    c.json({ token: tokens.revoke(c.get("actor"), c.req.param("id")) }));
}
