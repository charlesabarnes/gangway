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

export function schemaRoutes(pub: Hono<AppEnv>): void {
  const schema = gangwayJsonSchema();
  const cache = { "cache-control": "public, max-age=3600" };
  pub.get("/schema/gangway.yml", (c) => c.json(schema, 200, cache));
}
