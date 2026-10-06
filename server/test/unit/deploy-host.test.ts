import { describe, expect, test } from "bun:test";
import type { Project } from "@gangway/shared/domain";
import type { Permission } from "@gangway/shared/permissions";
import { tokenActor } from "../../src/auth/actor.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";
import {
  applyDeployHost,
  deployHostOf,
  type DeployHostDeps,
} from "../../src/projects/deploy-host.ts";

describe("deployHostOf", () => {
  test.each([
    [null, { label: "web-app", custom: null }],
    ["duck", { label: "duck", custom: null }],
    ["duck.demo.gangway.sh", { label: "duck", custom: null }],
    ["a.b.demo.gangway.sh", { label: "web-app", custom: "a.b.demo.gangway.sh" }],
    ["duck.example.com", { label: "web-app", custom: "duck.example.com" }],
    ["demo.gangway.sh", { label: "web-app", custom: "demo.gangway.sh" }],
  ])("%j under demo.gangway.sh", (deployHost, want) => {
    expect(deployHostOf({ slug: "web-app", deployHost }, "demo.gangway.sh")).toEqual(want);
  });
});

describe("applyDeployHost", () => {
  const project = {
    slug: "web-app",
    deployHost: null,
    domain: null,
    productionPreviewId: "p1",
  } as unknown as Project;
  const deps = (renames: string[]): DeployHostDeps => ({
    domainOf: () => "demo.gangway.sh",
    preview: () => ({ id: "p1", source: { kind: "tarball", branch: { sha: "a" } } }) as never,
    relabel: (id, label) => {
      renames.push(`${id}:${label}`);
      return new Map();
    },
    holds: () => false,
    claim: () => {
      throw new Error("no claim expected");
    },
  });
  const managerOnly = {
    ...tokenActor("t", ["admin"], HOME_ORG_ID),
    permissions: new Set<Permission>(["repos.manage"]),
  };

  test("a slug change renames production, and needs repos.domains for it", () => {
    const renames: string[] = [];
    const next = { ...project, slug: "shop" };
    expect(() => applyDeployHost(deps(renames), managerOnly, project, next)).toThrow(
      "repos.domains",
    );
    expect(renames).toEqual([]);
    const admin = tokenActor("t", ["admin"], HOME_ORG_ID);
    expect(applyDeployHost(deps(renames), admin, project, next)).not.toBeNull();
    expect(renames).toEqual(["p1:shop"]);
    expect(applyDeployHost(deps(renames), managerOnly, project, project)).toBeNull();
    const named = { ...project, deployHost: "duck" };
    expect(applyDeployHost(deps(renames), managerOnly, named, { ...named, slug: "x" })).toBeNull();
  });
});
