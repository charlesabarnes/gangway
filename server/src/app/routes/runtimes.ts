/**
 * ADR-0015: the runtime catalogue, for the New preview screen. ADR-0016: and the plan --
 * what the server would do with a set of files, asked before they are uploaded -- so the
 * screen shows the server's own answer, never a guess of its own.
 */
import type { Hono } from "hono";
import { planApp, PLAN_FILES } from "@gangway/shared/app-plan";
import { PlanRequestSchema } from "@gangway/shared/api";
import { gangwayJsonSchema } from "@gangway/shared/gangway-file";
import { DETECTION, RUNTIMES } from "@gangway/shared/runtimes";
import { ADDONS } from "@gangway/shared/addons";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { readJson } from "../problem.ts";

export function runtimeRoutes(api: Hono<AppEnv>): void {
  const body = {
    runtimes: RUNTIMES.map(
      ({ id, name, language, description, image, port, starter, versions }) => ({
        id,
        name,
        language,
        description,
        image,
        port,
        starter,
        versions: Object.keys(versions),
      }),
    ),
    detection: DETECTION,
    planFiles: PLAN_FILES,
    // ADR-0017: what can sit beside an app. Images are shown; hints stay server-side.
    addons: ADDONS.map(({ id, name, description, versions, defaultVersion, env }) => ({
      id,
      name,
      description,
      versions: Object.keys(versions),
      defaultVersion,
      env,
    })),
  };
  api.get("/runtimes", requirePermission("previews.read"), (c) => c.json(body));

  api.post("/runtimes/plan", requirePermission("previews.read"), async (c) => {
    const req = PlanRequestSchema.parse(await readJson(c));
    return c.json(
      planApp({ paths: req.paths, files: req.files, runtime: req.runtime, addons: req.addons }),
    );
  });
}

/**
 * PUBLIC: gangway.yml's JSON Schema, for editors (`# yaml-language-server: $schema=<url>`).
 * It says nothing about this installation.
 */
export function schemaRoutes(pub: Hono<AppEnv>): void {
  const schema = gangwayJsonSchema();
  pub.get("/schema/gangway.yml", (c) =>
    c.json(schema, 200, { "cache-control": "public, max-age=3600" }),
  );
}
