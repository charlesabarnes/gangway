/**
 * Every `/v1` route names the permission it needs. "Any authenticated actor" is not a
 * policy: a viewer-scoped credential would inherit whatever a new route forgot to guard.
 * Registration needs no working dependencies -- handlers are never called here.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { isPermission } from "../../../shared/src/permissions.ts";
import type { AppEnv } from "../../src/app/env.ts";
import { PERMISSION_GUARD } from "../../src/app/middleware/auth.ts";
import { auditRoutes } from "../../src/app/routes/audit.ts";
import { eventRoutes } from "../../src/app/routes/events.ts";
import { hostRoutes } from "../../src/app/routes/hosts.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { roleRoutes } from "../../src/app/routes/roles.ts";
import { githubRoutes } from "../../src/app/routes/github.ts";
import { projectRoutes } from "../../src/app/routes/projects.ts";
import { secretRoutes } from "../../src/app/routes/secrets.ts";
import { settingsRoutes } from "../../src/app/routes/settings.ts";
import { templateRoutes } from "../../src/app/routes/templates.ts";
import { tokenRoutes } from "../../src/app/routes/tokens.ts";
import { userRoutes } from "../../src/app/routes/users.ts";

const none = {} as never;

/** Everything mounted behind `authenticate`. Add a new route module HERE when boot.ts gains one. */
export function registerAuthenticated(api: Hono<AppEnv>): void {
  hostRoutes(api, none);
  eventRoutes(api, none);
  previewRoutes(api, none, none);
  auditRoutes(api, none);
  tokenRoutes(api, none);
  userRoutes(api, none);
  roleRoutes(api, none);
  settingsRoutes(api, none, none);
  projectRoutes(api, none);
  secretRoutes(api, none);
  githubRoutes(api, none);
  templateRoutes(api, none);
}

describe("route permissions", () => {
  const api = new Hono<AppEnv>();
  registerAuthenticated(api);

  const byRoute = new Map<string, string[]>();
  for (const r of api.routes) {
    const key = `${r.method} ${r.path}`;
    const guard = (r.handler as unknown as Record<symbol, unknown>)[PERMISSION_GUARD];
    byRoute.set(key, [...(byRoute.get(key) ?? []), ...(typeof guard === "string" ? [guard] : [])]);
  }

  test("there are routes to check", () => expect(byRoute.size).toBeGreaterThan(5));

  for (const [route, guards] of byRoute) {
    test(`${route} requires exactly one known permission`, () => {
      expect(guards).toHaveLength(1);
      expect(isPermission(guards[0]!)).toBe(true);
    });
  }

  test("reads and writes are different permissions", () => {
    expect(byRoute.get("GET /previews")).toEqual(["previews.read"]);
    expect(byRoute.get("POST /previews")).toEqual(["previews.deploy"]);
    expect(byRoute.get("DELETE /previews/:id")).toEqual(["previews.destroy"]);
    expect(byRoute.get("GET /previews/:id/logs")).toEqual(["logs.read"]);
  });
});
