import { describe, expect, test } from "bun:test";
import { tokenActor, type Actor } from "../../src/auth/actor.ts";
import { resolvePreview } from "../../src/mcp/resolve.ts";
import { setupTools } from "../helpers/mcp-tools.ts";
import { DAY } from "../helpers/preview-context.ts";
import { previewPasswordApi } from "../helpers/preview-password.ts";

type Wire = { preview: { ttlExpiresAt: string | null } };

const member = (permissions: string[]): Actor => ({
  kind: "user",
  userId: "u-bob",
  roleId: "member",
  permissions: new Set(permissions) as Actor["permissions"],
  sessionId: "s",
});

describe("PUT /v1/previews/:id/ttl", () => {
  test("adds to what is left, or to now once it has lapsed, and is audited", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    const now = t.ctx.now();
    t.previews.setTtlExpiresAt(p.id, new Date(now + DAY));

    const res = await t.putTtl(p.id, { extend: "7d" });
    expect(res.status).toBe(200);
    const at = Date.parse(((await res.json()) as Wire).preview.ttlExpiresAt!);
    expect(at).toBe(now + 8 * DAY);

    t.previews.setTtlExpiresAt(p.id, new Date(now - DAY));
    expect((await t.putTtl(p.id, { extend: "1d" })).status).toBe(200);
    const lapsed = t.previews.get(p.id)!.ttlExpiresAt!.getTime();
    expect(lapsed).toBeGreaterThanOrEqual(now + DAY);
    expect(lapsed).toBeLessThan(now + DAY + 60_000);

    const audit = t.db.query(
      "SELECT new_json FROM audit WHERE action = 'preview.extend' ORDER BY seq",
    ) as { new_json: string }[];
    expect(audit.map((a) => JSON.parse(a.new_json))).toEqual([
      new Date(now + 8 * DAY).toISOString(),
      new Date(lapsed).toISOString(),
    ]);
  });

  test('"none" keeps it forever, and a later extend does not bring the expiry back', async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    t.previews.setTtlExpiresAt(p.id, new Date(t.ctx.now() + DAY));
    const res = await t.putTtl(p.id, { extend: "none" });
    expect(((await res.json()) as Wire).preview.ttlExpiresAt).toBeNull();
    expect((await t.putTtl(p.id, { extend: "7d" })).status).toBe(200);
    expect(t.previews.get(p.id)!.ttlExpiresAt).toBeNull();
    expect(t.previews.expired(t.ctx.now() + 365 * DAY)).toEqual([]);
  });

  test("a bad duration is a 422, a destroyed preview a 409", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    expect((await t.putTtl(p.id, { extend: "soon" })).status).toBe(422);
    expect((await t.putTtl(p.id, { extend: "0d" })).status).toBe(422);
    expect((await t.putTtl(p.id, {})).status).toBe(422);
    t.db.run("UPDATE previews SET state = 'destroyed' WHERE id = $id", { id: p.id });
    expect((await t.putTtl(p.id, { extend: "1d" })).status).toBe(409);
  });

  test("needs previews.extend, and previews.update for someone else's preview", async () => {
    const without = previewPasswordApi(member(["previews.update"]));
    const a = await without.deployed("a");
    expect((await without.putTtl(a.id, { extend: "1d" })).status).toBe(403);

    const own = previewPasswordApi(member(["previews.update_own", "previews.extend"]));
    const b = await own.deployed("theirs");
    expect((await own.putTtl(b.id, { extend: "1d" })).status).toBe(403);
  });
});

describe("the extend tool", () => {
  test("extends by name and says until when; none keeps it", async () => {
    const s = setupTools();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "v1" },
      name: "keep",
      visibility: "public",
    });
    const id = resolvePreview(s.ctx, "keep").id;
    const now = s.ctx.now();
    s.ctx.previews.setTtlExpiresAt(id, new Date(now + DAY));
    const out = s.tools.extend(s.scope(), { preview: "keep", by: "2d" });
    expect(out).toStartWith("extended: keep");
    expect(out).toContain(`until ${new Date(now + 3 * DAY).toISOString()}`);
    expect(s.tools.extend(s.scope(), { preview: "keep", by: "none" })).toContain("(never expires)");
    expect(() => s.tools.extend(s.scope(), { preview: "keep", by: "later" })).toThrow(
      "is not a duration",
    );
  });

  test("is refused without previews.extend, and for someone else's with only update_own", async () => {
    const s = setupTools();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "v1" },
      name: "theirs",
      visibility: "public",
    });
    expect(() =>
      s.tools.extend(s.scope(tokenActor("t-read", ["read"])), { preview: "theirs", by: "1d" }),
    ).toThrow('"previews.extend"');
    const bob = { ...tokenActor("t-bob", ["deploy"]), userId: "bob" } as Actor;
    expect(() => s.tools.extend(s.scope(bob), { preview: "theirs", by: "1d" })).toThrow(
      "deployed by someone else",
    );
  });

  test("a rebuild with ttl points at the extend tool", async () => {
    const s = setupTools();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "v1" },
      name: "site",
      visibility: "public",
    });
    await expect(
      s.tools.deploy(s.scope(), { preview: "site", files: { "a.html": "" }, ttl: "7d" }),
    ).rejects.toThrow("extend tool");
  });
});
