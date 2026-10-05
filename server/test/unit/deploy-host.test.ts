import { describe, expect, test } from "bun:test";
import { deployHostOf } from "../../src/projects/deploy-host.ts";

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
