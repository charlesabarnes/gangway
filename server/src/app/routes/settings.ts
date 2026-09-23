import type { Hono } from "hono";
import { DefaultPasswordSchema, SetSettingsSchema } from "../../../../shared/src/api.ts";
import type { AuditSink } from "../../audit/audit.ts";
import { badRequest, conflict, unprocessable } from "../../errors.ts";
import type { TemplatesRepo } from "../../db/repos/templates.ts";
import { SETTINGS, SETTINGS_BY_KEY, type Settings } from "../../settings.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

/**
 * `/v1/settings` (§10.1, §10.5). GET reports every setting with its source; a secret is
 * reported as `set: true|false` and never as a value. PUT takes a partial map and writes
 * each value through its own schema. A key pinned in config is a 409: the API must not
 * pretend to change what the config will keep overriding.
 *
 * `surfaces.*` are refused here: they change only through `PUT /v1/surfaces`, which holds
 * the lockout guard and its own permission (`surfaces.manage`). `previews.password.*` too:
 * the shared password must be HASHED on the way in, so it has its own route (ADR-0023).
 */
export function settingsRoutes(
  api: Hono<AppEnv>,
  settings: Settings,
  audit: AuditSink,
  templates?: Pick<TemplatesRepo, "get">,
  hashPassword?: (plain: string) => Promise<{ hash: string; salt: string }>,
): void {
  api.get("/settings", requirePermission("settings.read"), (c) =>
    c.json({ settings: settings.view() }),
  );

  api.put("/settings", requirePermission("settings.write"), async (c) => {
    const body = await c.req.json().catch(() => {
      throw badRequest("the request body is not JSON");
    });
    const { values } = SetSettingsSchema.parse(body);
    const actor = c.get("actor");

    // Validate everything before writing anything: a PUT is applied whole or not at all.
    const writes: { key: string; value: unknown; secret: boolean; old: unknown }[] = [];
    for (const [key, raw] of Object.entries(values)) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) throw unprocessable(`"${key}" is not a setting`, { key });
      // §10.5.1: the lockout guard lives on /v1/surfaces; this door must not go round it.
      if (key.startsWith("surfaces."))
        throw conflict(`"${key}" is changed through PUT /v1/surfaces`, { key });
      if (key.startsWith("previews.password."))
        throw conflict(`"${key}" is changed through PUT /v1/settings/preview-password`, { key });
      if (settings.isManagedByConfig(key))
        throw conflict(`"${key}" is managed by config and cannot be changed at runtime`, { key });
      const parsed = def.schema.safeParse(raw);
      if (!parsed.success)
        throw unprocessable(`"${key}": ${parsed.error.issues[0]?.message ?? "invalid"}`, { key });
      // ADR-0013: a trigger default must name a template that exists.
      if (
        key.startsWith("templates.default.") &&
        templates &&
        !templates.get(parsed.data as string)
      )
        throw unprocessable(`"${key}": no such template: ${String(parsed.data)}`, { key });
      writes.push({
        key,
        value: parsed.data,
        secret: def.secret,
        old: settings.effective(def).value,
      });
    }
    for (const w of writes) settings.set(SETTINGS_BY_KEY.get(w.key)!, w.value);

    // Secrets are audited as changed, never as what they changed to.
    const shown = (w: (typeof writes)[number], v: unknown) =>
      w.secret ? (v === "" ? "[unset]" : "[set]") : v;
    audit.record(actor, "settings.changed", null, {
      old: Object.fromEntries(writes.map((w) => [w.key, shown(w, w.old)])),
      new: Object.fromEntries(writes.map((w) => [w.key, shown(w, w.value)])),
    });
    return c.json({ settings: settings.view() });
  });

  /**
   * ADR-0023: the password previews that inherit are behind. `off`; `shared`, one password
   * for all of them (a value is needed unless one is already set -- switching back to
   * `shared` keeps the old one); `generated`, each NEW preview gets its own, in its log.
   */
  api.put("/settings/preview-password", requirePermission("settings.write"), async (c) => {
    const body = await c.req.json().catch(() => {
      throw badRequest("the request body is not JSON");
    });
    const { mode, value, login } = DefaultPasswordSchema.parse(body);
    for (const d of [
      SETTINGS.previewPasswordMode,
      SETTINGS.previewPasswordShared,
      ...(login === undefined ? [] : [SETTINGS.previewPasswordLogin]),
    ]) {
      if (settings.isManagedByConfig(d.key))
        throw conflict(`"${d.key}" is managed by config and cannot be changed at runtime`, {
          key: d.key,
        });
    }
    const had = settings.effective(SETTINGS.previewPasswordShared).value;
    const old = settings.effective(SETTINGS.previewPasswordMode).value;
    const oldLogin = settings.effective(SETTINGS.previewPasswordLogin).value;
    if (mode === "shared" && value === undefined && had === null)
      throw unprocessable("a shared password needs a value the first time", {
        key: SETTINGS.previewPasswordShared.key,
      });
    if (value !== undefined && mode !== "shared")
      throw unprocessable('a value only goes with mode "shared"');
    if (value !== undefined) {
      if (!hashPassword)
        throw unprocessable("password-protected previews are not available on this server");
      settings.set(SETTINGS.previewPasswordShared, await hashPassword(value));
    }
    settings.set(SETTINGS.previewPasswordMode, mode);
    if (login !== undefined) settings.set(SETTINGS.previewPasswordLogin, login);
    audit.record(c.get("actor"), "settings.changed", null, {
      old: {
        [SETTINGS.previewPasswordLogin.key]: oldLogin,
        [SETTINGS.previewPasswordMode.key]: old,
        [SETTINGS.previewPasswordShared.key]: had === null ? "[unset]" : "[set]",
      },
      new: {
        [SETTINGS.previewPasswordLogin.key]: login ?? oldLogin,
        [SETTINGS.previewPasswordMode.key]: mode,
        [SETTINGS.previewPasswordShared.key]:
          value !== undefined ? "[changed]" : had === null ? "[unset]" : "[set]",
      },
    });
    return c.json({ settings: settings.view() });
  });
}
