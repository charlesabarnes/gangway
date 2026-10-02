import { describe, expect, test } from "bun:test";
import { tokenActor } from "../../src/auth/actor.ts";
import { setupTools } from "../helpers/mcp-tools.ts";

describe("the domains tool", () => {
  test("lists what a preview uses and may use", async () => {
    const s = setupTools();
    await s.deployed("shop");
    const out = await s.tools.domains(s.scope(), { target: { preview: "shop" } });
    expect(out).toContain("named under: preview.localhost");
    expect(out).toContain("available: preview.localhost, alt.localhost");
    expect(out).toContain("claimed: none");
  });

  test("choosing a domain says the preview moves on its next rebuild", async () => {
    const s = setupTools();
    await s.deployed("shop");
    const out = await s.tools.domains(s.scope(), {
      target: { preview: "shop" },
      use: "alt.localhost",
    });
    expect(out).toContain("each preview moves when it is next deployed or rebuilt");
    expect(out).toContain(
      "named under: alt.localhost (still shop.preview.localhost until its next rebuild)",
    );
    const status = await s.tools.status(s.scope(), "shop");
    expect(status).toContain("moves to alt.localhost on its next rebuild");
  });

  test("choosing production drops the preview's TTL, and destroy then refuses it", async () => {
    const s = setupTools();
    const p = await s.deployed("shop");
    s.projects.create({ id: "p1", name: "web", slug: "web" });
    s.db.run("UPDATE previews SET project_id = 'p1' WHERE id = $id", { id: p.id });
    const out = await s.tools.domains(s.scope(), {
      target: { project: "web" },
      production: "shop",
    });
    expect(out).toContain("production is now shop");
    expect(s.ctx.previews.get(p.id)!.ttlExpiresAt).toBeNull();
    await expect(s.tools.destroy(s.scope(), "shop")).rejects.toThrow("web's production");
  });

  test("a claim answers with the records to set, and check makes it active", async () => {
    const s = setupTools();
    s.projects.create({ id: "p1", name: "web", slug: "web" });
    const out = await s.tools.domains(s.scope(), {
      target: { project: "web" },
      claim: "*.previews.client.com",
    });
    expect(out).toContain("claimed *.previews.client.com");
    const cname = /CNAME _acme-challenge\.previews\.client\.com -> (\S+)/.exec(out)![1]!;
    expect(cname).toEndWith(".acme.preview.localhost");
    expect(out).toContain("CNAME *.previews.client.com -> preview.localhost");

    s.dns.cname.set("_acme-challenge.previews.client.com", cname);
    const checked = await s.tools.domains(s.scope(), { target: { project: "web" }, check: true });
    expect(checked).toContain("*.previews.client.com: active; DNS does not send it here yet");
    expect(s.registry.availableTo("p1")).toContain("previews.client.com");
  });

  test("a deploy agent may choose a preview's domain, not claim the server's", async () => {
    const s = setupTools();
    const agent = tokenActor("t-deploy", ["deploy"]);
    const out = await s.tools
      .domains(s.scope(agent), { target: { org: true }, claim: "x.example" })
      .catch((e: Error) => e.message);
    expect(String(out)).toContain("domains.manage");
  });
});
