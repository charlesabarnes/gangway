import type { Hono } from "hono";
import { EnvPatchSchema } from "../../../../shared/src/api.ts";
import { badRequest } from "../../errors.ts";
import type { Secrets } from "../../secrets/secrets.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

/**
 * `/v1/secrets` (ADR-0012): the GLOBAL map -- what every preview may receive, at or below
 * its clearance; a repository's own entries win over these on a name. Same shape as
 * `/v1/repos/:id/env`: names and levels out, merges in, never a value back.
 */
export function secretRoutes(api: Hono<AppEnv>, secrets: Secrets): void {
  api.get("/secrets", requirePermission("repos.secrets"), (c) =>
    c.json({ secrets: secrets.global().list() }),
  );

  api.patch("/secrets", requirePermission("repos.secrets"), async (c) => {
    const body = await c.req.json().catch(() => {
      throw badRequest("the request body is not JSON");
    });
    const patch = EnvPatchSchema.parse(body);
    return c.json({ secrets: secrets.global().update(c.get("actor"), patch) });
  });
}
