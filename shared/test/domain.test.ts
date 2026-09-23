import { describe, expect, test } from "bun:test";
import { projectNameFor } from "../src/domain.ts";

describe("projectNameFor", () => {
  test("carries the instance so two installations never share a compose project", () => {
    expect(projectNameFor("docker-host", "acme-pr-123")).toBe("gw-docker-host-acme-pr-123");
    expect(projectNameFor("default", "whoami")).toBe("gw-default-whoami");
    expect(projectNameFor("laptop", "whoami")).not.toBe(projectNameFor("docker-host", "whoami"));
  });
});
