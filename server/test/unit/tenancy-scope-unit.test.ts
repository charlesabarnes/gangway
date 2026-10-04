import { describe, expect, test } from "bun:test";
import { acrossOrgs, beforeOrg, orgFilter, orgScope, withOrg } from "../../src/tenancy/scope.ts";

describe("the org a piece of work runs as", () => {
  test("background work spans every org; a request runs as the org it named", async () => {
    expect(orgScope()).toBe("fleet");
    expect(orgFilter()).toEqual({ sql: "1", params: {} });
    await withOrg("o1", async () => {
      await Bun.sleep(1);
      expect(orgScope()).toEqual({ org: "o1" });
      expect(orgFilter("p.org_id")).toEqual({ sql: "p.org_id = $org", params: { org: "o1" } });
      expect(acrossOrgs(() => orgScope())).toBe("fleet");
    });
  });

  test("a request that has not named its org yet reads nothing org-scoped", () => {
    beforeOrg(() => {
      expect(() => orgScope()).toThrow("before the request named its org");
      expect(withOrg("o2", () => orgScope())).toEqual({ org: "o2" });
    });
  });
});
