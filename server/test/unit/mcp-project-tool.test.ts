import { describe, expect, test } from "bun:test";
import { SCOPE_PERMISSIONS } from "@gangway/shared/permissions";
import { tokenActor } from "../../src/auth/actor.ts";
import { MissingPermission } from "../../src/mcp/tool-access.ts";
import { setupTools } from "../helpers/mcp-tools.ts";

const CONNECTOR = tokenActor("t-projects", ["read", "deploy", "projects"]);

describe("the project tool", () => {
  test("the projects scope is what connecting a repository needs, and no more", () => {
    expect(SCOPE_PERMISSIONS.projects).toEqual(["previews.read", "repos.manage"]);
  });

  test("creates a workflow project and returns its workflow with the port filled in", () => {
    const s = setupTools();
    const out = s.tools.project(s.scope(CONNECTOR), { repository: "acme/Shop-Front", port: 8080 });
    expect(out).toContain('acme/Shop-Front is project "shop-front" (created now)');
    expect(out).toContain(
      "--- .github/workflows/gangway-preview.yml\n# gangway previews for Shop-Front",
    );
    expect(out).toContain('PORT: "8080"');
    expect(out).toContain("GANGWAY_PROJECT: shop-front");
    expect(out).toContain("GANGWAY_API: https://api.preview.localhost:8443");
    const p = s.projects.getByFullName("github", "acme/Shop-Front")!;
    expect(p.prTrigger).toBe("workflow");
    expect(s.audit.page({ limit: 10, action: "project.created" }).entries).toHaveLength(1);
  });

  test("a second call finds the same project and makes nothing new", () => {
    const s = setupTools();
    s.tools.project(s.scope(CONNECTOR), { repository: "acme/shop", slug: "storefront" });
    const again = s.tools.project(s.scope(CONNECTOR), { repository: "acme/shop" });
    expect(again).toContain('acme/shop is project "storefront" (already connected)');
    expect(again).toContain('PORT: "3000"');
    expect(s.projects.list()).toHaveLength(1);
  });

  test("a repository the GitHub App previews needs no workflow", () => {
    const s = setupTools();
    s.projects.create({
      id: "p1",
      name: "shop",
      slug: "shop",
      forge: "github",
      fullName: "acme/shop",
      prTrigger: "webhook",
    });
    const out = s.tools.project(s.scope(CONNECTOR), { repository: "acme/shop" });
    expect(out).toContain("GitHub App already previews");
    expect(out).not.toContain("gangway-preview.yml");
  });

  test("a disabled project says so alongside the workflow", () => {
    const s = setupTools();
    s.projects.create({
      id: "p1",
      name: "shop",
      slug: "shop",
      forge: "github",
      fullName: "acme/shop",
      enabled: false,
      disabledReason: "turned off by the owner",
    });
    const out = s.tools.project(s.scope(CONNECTOR), { repository: "acme/shop" });
    expect(out).toContain("It is disabled: turned off by the owner.");
    expect(out).toContain("gangway-preview.yml");
  });

  test("a deploy-scope connection is refused, and told which scope to grant", () => {
    const s = setupTools();
    const deployOnly = tokenActor("t-deploy", ["read", "deploy"]);
    expect(() => s.tools.project(s.scope(deployOnly), { repository: "acme/shop" })).toThrow(
      MissingPermission,
    );
    expect(() => s.tools.project(s.scope(deployOnly), { repository: "acme/shop" })).toThrow(
      "grant the projects scope",
    );
    expect(s.projects.list()).toHaveLength(0);
    expect(s.tools.missingFor(deployOnly, "project", { repository: "acme/shop" })).toBe(
      "repos.manage",
    );
  });
});
