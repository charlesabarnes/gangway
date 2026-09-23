import { describe, expect, test } from "bun:test";
import type { Actor } from "../../src/auth/actor.ts";
import { SETTINGS } from "../../src/settings.ts";
import { passwords, previewPasswordApi, settingsPasswordApi } from "../helpers/preview-password.ts";

describe("PUT /v1/previews/:id/password", () => {
  test("set, generate and none take effect on the route at once, audited by mode only", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    let res = await t.put(p.id, { password: { mode: "set", value: "brand new password" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { preview: { password: string } }).preview.password).toBe("set");
    expect(t.table.forPreview(p.id)[0]!.password.mode).toBe("own");

    res = await t.put(p.id, { password: { mode: "generate" } });
    expect(((await res.json()) as { preview: { password: string } }).preview.password).toBe(
      "generated",
    );
    const lines = t.ctx.logs
      .tail(p.id, 500)
      .filter((l) => l.includes("preview password (generated"));
    expect(lines).toHaveLength(1);
    const plain = /: ([a-z0-9-]{19})$/.exec(lines[0]!)![1]!;
    expect(JSON.stringify(t.previews.get(p.id))).not.toContain(plain);

    await t.put(p.id, { password: { mode: "none" } });
    expect(t.table.forPreview(p.id)[0]!.password).toEqual({ mode: "none" });
    const audit = t.db.query<{ action: string; new_json: string }>(
      "SELECT action, new_json FROM audit WHERE action = 'preview.password' ORDER BY seq",
    );
    expect(audit.map((a) => JSON.parse(a.new_json).mode)).toEqual(["set", "generated", "none"]);
    expect(JSON.stringify(audit)).not.toContain("brand new password");
  });

  test("any length but empty; someone else's preview needs previews.update", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("mine");
    expect((await t.put(p.id, { password: { mode: "set", value: "" } })).status).toBe(422);
    expect((await t.put(p.id, { password: { mode: "set", value: "a" } })).status).toBe(200);

    const member: Actor = {
      kind: "user",
      userId: "u-bob",
      roleId: "member",
      permissions: new Set(["previews.update_own"]),
      sessionId: "s",
    };
    const other = previewPasswordApi(member);
    const q = await other.deployed("theirs");
    expect((await other.put(q.id, { password: { mode: "none" } })).status).toBe(403);
  });
});

describe("PUT /v1/settings/preview-password", () => {
  test("shared: hashed into a secret setting, reported as set, never as a value", async () => {
    const t = settingsPasswordApi();
    const res = await t.put("/settings/preview-password", {
      mode: "shared",
      value: "team password",
    });
    expect(res.status).toBe(200);
    const view = (
      (await res.json()) as { settings: { key: string; value: unknown; set: boolean }[] }
    ).settings;
    expect(view.find((v) => v.key === "previews.password.mode")?.value).toBe("shared");
    expect(view.find((v) => v.key === "previews.password.shared")).toMatchObject({
      value: null,
      set: true,
    });
    expect(
      await passwords.verify("team password", t.settings.get(SETTINGS.previewPasswordShared)!),
    ).toBe(true);
    expect(JSON.stringify(t.records)).not.toContain("team password");
  });

  test("shared needs a value the first time, and keeps the old one after", async () => {
    const t = settingsPasswordApi();
    expect((await t.put("/settings/preview-password", { mode: "shared" })).status).toBe(422);
    await t.put("/settings/preview-password", { mode: "shared", value: "team password" });
    await t.put("/settings/preview-password", { mode: "off" });
    expect((await t.put("/settings/preview-password", { mode: "shared" })).status).toBe(200);
    expect(
      await passwords.verify("team password", t.settings.get(SETTINGS.previewPasswordShared)!),
    ).toBe(true);
  });

  test("a value with any other mode is refused; the generic PUT cannot write these keys", async () => {
    const t = settingsPasswordApi();
    expect(
      (await t.put("/settings/preview-password", { mode: "generated", value: "team password" }))
        .status,
    ).toBe(422);
    expect(
      (
        await t.put("/settings", {
          values: { "previews.password.shared": { hash: "x", salt: "y" } },
        })
      ).status,
    ).toBe(409);
    expect(
      (await t.put("/settings", { values: { "previews.password.mode": "shared" } })).status,
    ).toBe(409);
    expect((await t.put("/settings/preview-password", { mode: "generated" })).status).toBe(200);
    expect(t.settings.get(SETTINGS.previewPasswordMode)).toBe("generated");
  });
});
