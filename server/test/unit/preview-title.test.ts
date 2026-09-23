import { describe, expect, test } from "bun:test";
import { deploy } from "../../src/previews/deploy.ts";
import type { Actor } from "../../src/auth/actor.ts";
import { previewPasswordApi } from "../helpers/preview-password.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

const image = { kind: "image" as const, image: "traefik/whoami:v1.10", port: 80 };

describe("preview titles", () => {
  test("a title is kept as typed and gives the slug when no name is sent", async () => {
    const { ctx } = setupPreviewContext();
    const p = await (
      await deploy(ctx, {
        actor: ACTOR,
        title: "Checkout: v2 ✨",
        visibility: "public",
        source: image,
      })
    ).done;
    expect(p.title).toBe("Checkout: v2 ✨");
    expect(p.project).toEndWith("-checkout-v2");
  });

  test("a name still sets the slug, apart from the title", async () => {
    const { ctx } = setupPreviewContext();
    const input = { actor: ACTOR, name: "shop", title: "The shop", visibility: "public" as const };
    const p = await (await deploy(ctx, { ...input, source: image })).done;
    expect(p.project).toEndWith("-shop");
    expect(p.title).toBe("The shop");
  });
});

describe("PUT /v1/previews/:id/title", () => {
  test("renames, clears with null, and is audited", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    expect(p.title).toBeNull();
    const res = await t.putTitle(p.id, { title: "  Demo for Sam  " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { preview: { title: string } }).preview.title).toBe(
      "Demo for Sam",
    );
    expect((await t.putTitle(p.id, { title: null })).status).toBe(200);
    expect(t.previews.get(p.id)!.title).toBeNull();
    const audit = t.db.query<{ new_json: string }>(
      "SELECT new_json FROM audit WHERE action = 'preview.title' ORDER BY seq",
    );
    expect(audit.map((a) => JSON.parse(a.new_json))).toEqual(["Demo for Sam", null]);
  });

  test("empty or over 100 characters is refused", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    expect((await t.putTitle(p.id, { title: "   " })).status).toBe(422);
    expect((await t.putTitle(p.id, { title: "x".repeat(101) })).status).toBe(422);
  });

  test("someone else's preview needs previews.update", async () => {
    const member: Actor = {
      kind: "user",
      userId: "u-bob",
      roleId: "member",
      permissions: new Set(["previews.update_own"]),
      sessionId: "s",
    };
    const t = previewPasswordApi(member);
    const q = await t.deployed("theirs");
    expect((await t.putTitle(q.id, { title: "mine now" })).status).toBe(403);
  });
});
