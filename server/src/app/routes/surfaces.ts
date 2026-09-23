import type { Hono } from "hono";
import { DISABLE_UI_PHRASE, SetSurfacesSchema } from "@gangway/shared/api";
import type { AuditSink } from "../../audit/audit.ts";
import { conflict, unprocessable } from "../../errors.ts";
import { readJson } from "../problem.ts";
import { SETTINGS, type SettingDef, type Settings } from "../../settings.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export type SurfacesDeps = {
  settings: Settings;
  audit: AuditSink;
  /** An unexpired, unrevoked `admin`-scoped database token whose owner can still use it. */
  hasActiveAdmin: () => boolean;
  /** Public origins, for the MCP URL and the re-enable `curl` the UI shows. */
  apiOrigin: () => string;
  mcpOrigin: () => string;
  /** Turning MCP off drops in-flight sessions, not only new ones. */
  onMcpDisabled?: (() => void) | undefined;
};

const SURFACES = { ui: SETTINGS.surfacesUi, mcp: SETTINGS.surfacesMcp } as const satisfies Record<
  string,
  SettingDef<boolean>
>;
type SurfaceName = keyof typeof SURFACES;

/**
 * Surface toggles. Flags the dispatcher reads per request: no restart, and a disabled
 * surface is a 404, not a 503.
 *
 * `PUT /v1/surfaces` is the only way to change them at runtime -- `/v1/settings` refuses
 * `surfaces.*` -- because the lockout guard lives here. Disabling the UI from the UI is a
 * one-way door, so it is refused unless an admin-scoped API token exists, and needs a typed
 * phrase. The env admin token does not count: when GANGWAY_ADMIN_TOKEN is unset it is made
 * up per boot, and the operator may never have seen it.
 */
export function surfaceRoutes(api: Hono<AppEnv>, d: SurfacesDeps): void {
  const state = (name: SurfaceName) => {
    const e = d.settings.effective(SURFACES[name]);
    return { enabled: e.value, managedByConfig: e.managedByConfig };
  };
  const view = () => ({
    ui: state("ui"),
    mcp: { ...state("mcp"), url: d.mcpOrigin() },
    adminTokenExists: d.hasActiveAdmin(),
    reenableUi: `curl -X PUT ${d.apiOrigin()}/v1/surfaces -H "Authorization: Bearer <admin token>" -H "content-type: application/json" -d '{"ui":true}'`,
  });

  // What is live, for anyone who can see previews: the UI's nav and an agent's own checks.
  api.get("/capabilities", requirePermission("previews.read"), (c) =>
    c.json({
      surfaces: {
        ui: d.settings.get(SETTINGS.surfacesUi),
        mcp: d.settings.get(SETTINGS.surfacesMcp),
      },
      mcpUrl: d.mcpOrigin(),
    }),
  );

  api.get("/surfaces", requirePermission("surfaces.manage"), (c) => c.json({ surfaces: view() }));

  api.put("/surfaces", requirePermission("surfaces.manage"), async (c) => {
    const body = await readJson(c);
    const req = SetSurfacesSchema.parse(body);

    // Validate everything before writing anything.
    const changes: { name: SurfaceName; old: boolean; value: boolean }[] = [];
    for (const name of ["ui", "mcp"] as const) {
      const value = req[name];
      if (value === undefined) continue;
      const def = SURFACES[name];
      if (d.settings.isManagedByConfig(def.key))
        throw conflict(
          `the ${name} surface is managed by config and cannot be changed at runtime`,
          { surface: name },
        );
      const old = d.settings.get(def);
      if (old !== value) changes.push({ name, old, value });
    }
    if (changes.some((ch) => ch.name === "ui" && !ch.value)) {
      if (req.confirm !== DISABLE_UI_PHRASE)
        throw unprocessable(`turning the UI off needs "confirm": "${DISABLE_UI_PHRASE}"`, {
          phrase: DISABLE_UI_PHRASE,
        });
      if (!d.hasActiveAdmin()) {
        throw conflict(
          "refusing to turn the UI off: no unexpired admin-scoped API token exists, so there would be no way back in. Create one under Account -> API tokens first",
          { reason: "no_admin_token" },
        );
      }
    }

    for (const ch of changes) {
      d.settings.set(SURFACES[ch.name], ch.value);
      // `setting`, never `key`: redact() hides a field named key.
      d.audit.record(c.get("actor"), "surface.changed", ch.name, {
        old: { setting: SURFACES[ch.name].key, enabled: ch.old },
        new: { setting: SURFACES[ch.name].key, enabled: ch.value },
      });
      if (ch.name === "mcp" && !ch.value) d.onMcpDisabled?.();
    }
    return c.json({ surfaces: view() });
  });
}
