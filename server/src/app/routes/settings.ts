import type { Hono } from "hono";
import { SetSettingsSchema } from "../../../../shared/src/api.ts";
import type { AuditSink } from "../../audit/audit.ts";
import { badRequest, conflict, unprocessable } from "../../errors.ts";
import type { TemplatesRepo } from "../../db/repos/templates.ts";
import { SETTINGS_BY_KEY, type Settings } from "../../settings.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

/**
 * `/v1/settings` (§10.1, §10.5). GET reports every setting with its source; a secret is
 * reported as `set: true|false` and never as a value. PUT takes a partial map and writes
 * each value through its own schema. A key pinned in config is a 409: the API must not
 * pretend to change what the config will keep overriding.
 *
 * `surfaces.*` are refused here: they change only through `PUT /v1/surfaces`, which holds
 * the lockout guard and its own permission (`surfaces.manage`).
 */
export function settingsRoutes(api: Hono<AppEnv>, settings: Settings, audit: AuditSink, templates?: Pick<TemplatesRepo, "get">): void {
  api.get("/settings", requirePermission("settings.read"), (c) => c.json({ settings: settings.view() }));

  api.put("/settings", requirePermission("settings.write"), async (c) => {
    const body = await c.req.json().catch(() => { throw badRequest("the request body is not JSON"); });
    const { values } = SetSettingsSchema.parse(body);
    const actor = c.get("actor");

    // Validate everything before writing anything: a PUT is applied whole or not at all.
    const writes: { key: string; value: unknown; secret: boolean; old: unknown }[] = [];
    for (const [key, raw] of Object.entries(values)) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) throw unprocessable(`"${key}" is not a setting`, { key });
      // §10.5.1: the lockout guard lives on /v1/surfaces; this door must not go round it.
      if (key.startsWith("surfaces.")) throw conflict(`"${key}" is changed through PUT /v1/surfaces`, { key });
      if (settings.isManagedByConfig(key)) throw conflict(`"${key}" is managed by config and cannot be changed at runtime`, { key });
      const parsed = def.schema.safeParse(raw);
      if (!parsed.success) throw unprocessable(`"${key}": ${parsed.error.issues[0]?.message ?? "invalid"}`, { key });
      // ADR-0013: a trigger default must name a template that exists.
      if (key.startsWith("templates.default.") && templates && !templates.get(parsed.data as string)) throw unprocessable(`"${key}": no such template: ${String(parsed.data)}`, { key });
      writes.push({ key, value: parsed.data, secret: def.secret, old: settings.effective(def).value });
    }
    for (const w of writes) settings.set(SETTINGS_BY_KEY.get(w.key)!, w.value);

    // Secrets are audited as changed, never as what they changed to.
    const shown = (w: (typeof writes)[number], v: unknown) => (w.secret ? (v === "" ? "[unset]" : "[set]") : v);
    audit.record(actor, "settings.changed", null, {
      old: Object.fromEntries(writes.map((w) => [w.key, shown(w, w.old)])),
      new: Object.fromEntries(writes.map((w) => [w.key, shown(w, w.value)])),
    });
    return c.json({ settings: settings.view() });
  });
}
