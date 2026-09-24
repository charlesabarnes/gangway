import { describe, expect, test } from "bun:test";
import { deploy } from "../../src/previews/deploy.ts";
import { setupTools } from "../helpers/mcp-tools.ts";
import { previewPasswordApi } from "../helpers/preview-password.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

const image = { kind: "image" as const, image: "traefik/whoami:v1.10", port: 80 };

describe("preview icons", () => {
  test("a deploy keeps its icon and colour", async () => {
    const { ctx } = setupPreviewContext();
    const icon = { name: "rocket" as const, color: "teal" as const };
    const p = await (
      await deploy(ctx, { actor: ACTOR, icon, visibility: "public", source: image })
    ).done;
    expect(p.icon).toEqual(icon);
    expect(ctx.previews.get(p.id)!.icon).toEqual(icon);
  });

  test("PUT /v1/previews/:id/icon sets, defaults the colour, clears and audits", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    expect(p.icon).toBeNull();
    const res = await t.putIcon(p.id, { icon: { name: "chart-line" } });
    expect(res.status).toBe(200);
    expect(t.previews.get(p.id)!.icon).toEqual({ name: "chart-line", color: "navy" });
    expect((await t.putIcon(p.id, { icon: null })).status).toBe(200);
    expect(t.previews.get(p.id)!.icon).toBeNull();
    expect((await t.putIcon(p.id, { icon: { name: "not-an-icon" } })).status).toBe(422);
    expect((await t.putIcon(p.id, { icon: { name: "star", color: "pink" } })).status).toBe(422);
    const audit = t.db.query<{ n: number }>(
      "SELECT count(*) AS n FROM audit WHERE action = 'preview.icon'",
    );
    expect(audit[0]!.n).toBe(2);
  });
});

describe("the MCP asks for a title and an icon", () => {
  test("a deploy without them says how to add them", async () => {
    const s = setupTools();
    const out = await s.tools.deploy(s.scope(), {
      files: { "index.html": "<h1>hi</h1>" },
      name: "bare",
      visibility: "public",
    });
    expect(out).toContain("no title or icon: gangway lists it by its address");
  });

  test("a deploy with them shows them and does not nag", async () => {
    const s = setupTools();
    const out = await s.tools.deploy(s.scope(), {
      files: { "index.html": "<h1>hi</h1>" },
      name: "shop",
      title: "The shop",
      icon: "shopping-cart",
      iconColor: "green",
      visibility: "public",
    });
    expect(out).toContain('"The shop" — icon shopping-cart (green)');
    expect(out).not.toContain("no title");
  });

  test("an artifact's title becomes the preview's title", async () => {
    const s = setupTools();
    const out = await s.tools.deploy(s.scope(), {
      artifact: { template: "deck/pitch", title: "Board deck" },
      name: "board",
      visibility: "public",
    });
    expect(out).toContain('"Board deck"');
    expect(out).toContain("no icon:");
  });

  test("preview + title and icon relabels it without a rebuild", async () => {
    const s = setupTools();
    await s.tools.deploy(s.scope(), {
      files: { "index.html": "<h1>hi</h1>" },
      name: "later",
      visibility: "public",
    });
    const out = await s.tools.deploy(s.scope(), {
      preview: "later",
      title: "Named later",
      icon: "star",
    });
    expect(out).toStartWith("relabelled (no rebuild):");
    expect(out).toContain('"Named later" — icon star (navy)');
  });

  test("iconColor without icon is refused", async () => {
    const s = setupTools();
    const call = s.tools.deploy(s.scope(), {
      files: { "index.html": "<h1>hi</h1>" },
      iconColor: "red",
    });
    expect(call).rejects.toThrow("iconColor goes with icon");
  });
});
