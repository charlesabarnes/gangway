import { describe, expect, test } from "bun:test";
import { projectNameFor } from "../src/domain.ts";

describe("projectNameFor", () => {
  test("carries the instance, always -- two installations on one daemon must not share a compose project", () => {
    expect(projectNameFor("docker-host", "acme-pr-123")).toBe("gw-docker-host-acme-pr-123");
    expect(projectNameFor("default", "whoami")).toBe("gw-default-whoami");
    // The same slug under another instance is another project: compose keys on this name.
    expect(projectNameFor("laptop", "whoami")).not.toBe(projectNameFor("docker-host", "whoami"));
  });
});
