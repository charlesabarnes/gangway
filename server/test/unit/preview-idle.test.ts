import { describe, expect, test } from "bun:test";
import type { Actor } from "../../src/auth/actor.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";
import { resolvePreview } from "../../src/mcp/resolve.ts";
import type { ComposeModel } from "../../src/previews/compose-model.ts";
import { followStackIdle } from "../../src/previews/idle.ts";
import { setupTools } from "../helpers/mcp-tools.ts";
import { previewPasswordApi } from "../helpers/preview-password.ts";

type Wire = { preview: { idleAfterMs: number | null } };

const member = (permissions: string[]): Actor => ({
  kind: "user",
  orgId: HOME_ORG_ID,
  userId: "u-bob",
  roleId: "member",
  permissions: new Set(permissions) as Actor["permissions"],
  sessionId: "s",
});

const stack = (idle?: string) => ({ x: idle === undefined ? {} : { idle } }) as ComposeModel;

describe("PUT /v1/previews/:id/idle", () => {
  test('"never" keeps it awake, a duration sets the window, and each change is audited', async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    t.previews.setIdleAfterMs(p.id, 1_800_000);

    const res = await t.putIdle(p.id, { idle: "never" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Wire).preview.idleAfterMs).toBe(0);
    expect((await t.putIdle(p.id, { idle: "never" })).status).toBe(200);
    expect((await t.putIdle(p.id, { idle: "2h" })).status).toBe(200);
    expect(t.previews.get(p.id)!.idleAfterMs).toBe(7_200_000);

    const audit = t.db.query(
      "SELECT old_json, new_json FROM audit WHERE action = 'preview.idle' ORDER BY seq",
    ) as { old_json: string; new_json: string }[];
    expect(audit.map((a) => [JSON.parse(a.old_json), JSON.parse(a.new_json)])).toEqual([
      [1_800_000, 0],
      [0, 7_200_000],
    ]);
  });

  test("a bad duration is a 422, a destroyed preview a 409", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    expect((await t.putIdle(p.id, { idle: "soon" })).status).toBe(422);
    expect((await t.putIdle(p.id, { idle: "0" })).status).toBe(422);
    expect((await t.putIdle(p.id, {})).status).toBe(422);
    t.db.run("UPDATE previews SET state = 'destroyed' WHERE id = $id", { id: p.id });
    expect((await t.putIdle(p.id, { idle: "never" })).status).toBe(409);
  });

  test("someone else's preview needs previews.update", async () => {
    const own = previewPasswordApi(member(["previews.update_own"]));
    const theirs = await own.deployed("theirs");
    expect((await own.putIdle(theirs.id, { idle: "never" })).status).toBe(403);
    const none = previewPasswordApi(member(["previews.extend"]));
    const other = await none.deployed("other");
    expect((await none.putIdle(other.id, { idle: "never" })).status).toBe(403);
  });
});

describe("the extend tool's idle", () => {
  test("keeps a preview awake by name, alone or with a longer life", async () => {
    const s = setupTools();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "v1" },
      name: "keep",
      visibility: "public",
    });
    const id = resolvePreview(s.ctx, "keep").id;
    expect(s.tools.extend(s.scope(), { preview: "keep", idle: "never" })).toContain("stays awake");
    expect(s.ctx.previews.get(id)!.idleAfterMs).toBe(0);
    const both = s.tools.extend(s.scope(), { preview: "keep", by: "none", idle: "45m" });
    expect(both).toContain("never expires; sleeps after 45m idle");
    expect(() => s.tools.extend(s.scope(), { preview: "keep" })).toThrow('"by"');
    expect(() => s.tools.extend(s.scope(), { preview: "keep", idle: "later" })).toThrow(
      "is not a duration",
    );
  });
});

describe("a redeploy", () => {
  test("takes the idle its source states; a source that states none changes nothing", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    await t.putIdle(p.id, { idle: "never" });
    followStackIdle(t.ctx, p.id, stack());
    expect(t.previews.get(p.id)!.idleAfterMs).toBe(0);
    followStackIdle(t.ctx, p.id, stack("1h"));
    expect(t.previews.get(p.id)!.idleAfterMs).toBe(3_600_000);
    followStackIdle(t.ctx, p.id, stack("never"));
    expect(t.previews.get(p.id)!.idleAfterMs).toBe(0);
  });
});
