import type { Hono } from "hono";
import { DefaultPasswordSchema, SetSettingsSchema } from "@gangway/shared/api";
import type { AuditSink } from "../../audit/audit.ts";
import { conflict, unprocessable } from "../../errors.ts";
import { readJson } from "../problem.ts";
import type { TemplatesRepo } from "../../db/repos/templates.ts";
import { SETTINGS, SETTINGS_BY_KEY, type Settings } from "../../settings.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

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
    const body = await readJson(c);
    const { values } = SetSettingsSchema.parse(body);
    const actor = c.get("actor");

    const writes = Object.entries(values).map(([key, raw]) =>
      validateWrite(settings, templates, key, raw),
    );
    for (const w of writes) settings.set(SETTINGS_BY_KEY.get(w.key)!, w.value);

    audit.record(actor, "settings.changed", null, {
      old: Object.fromEntries(writes.map((w) => [w.key, shown(w, w.old)])),
      new: Object.fromEntries(writes.map((w) => [w.key, shown(w, w.value)])),
    });
    return c.json({ settings: settings.view() });
  });

  api.put("/settings/preview-password", requirePermission("settings.write"), async (c) => {
    const body = await readJson(c);
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
    const hadShown = had === null ? "[unset]" : "[set]";
    audit.record(c.get("actor"), "settings.changed", null, {
      old: {
        [SETTINGS.previewPasswordLogin.key]: oldLogin,
        [SETTINGS.previewPasswordMode.key]: old,
        [SETTINGS.previewPasswordShared.key]: hadShown,
      },
      new: {
        [SETTINGS.previewPasswordLogin.key]: login ?? oldLogin,
        [SETTINGS.previewPasswordMode.key]: mode,
        [SETTINGS.previewPasswordShared.key]: value !== undefined ? "[changed]" : hadShown,
      },
    });
    return c.json({ settings: settings.view() });
  });
}

type SettingWrite = { key: string; value: unknown; secret: boolean; old: unknown };

function validateWrite(
  settings: Settings,
  templates: Pick<TemplatesRepo, "get"> | undefined,
  key: string,
  raw: unknown,
): SettingWrite {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw unprocessable(`"${key}" is not a setting`, { key });
  // The lockout guard lives on /v1/surfaces; this route must not bypass it.
  if (key.startsWith("surfaces."))
    throw conflict(`"${key}" is changed through PUT /v1/surfaces`, { key });
  if (key.startsWith("previews.password."))
    throw conflict(`"${key}" is changed through PUT /v1/settings/preview-password`, { key });
  if (settings.isManagedByConfig(key))
    throw conflict(`"${key}" is managed by config and cannot be changed at runtime`, { key });
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success)
    throw unprocessable(`"${key}": ${parsed.error.issues[0]?.message ?? "invalid"}`, { key });
  if (key.startsWith("templates.default.") && templates && !templates.get(parsed.data as string))
    throw unprocessable(`"${key}": no such template: ${String(parsed.data)}`, { key });
  return { key, value: parsed.data, secret: def.secret, old: settings.effective(def).value };
}

function shown(w: SettingWrite, v: unknown): unknown {
  if (!w.secret) return v;
  return v === "" ? "[unset]" : "[set]";
}
