import { describe, expect, test } from "bun:test";
import { must } from "../src/must.ts";

describe("must", () => {
  test("returns a present value, including falsy ones", () => {
    expect(must(0, "a count")).toBe(0);
    expect(must("", "a name")).toBe("");
    expect(must(false, "a flag")).toBe(false);
  });

  test("throws naming what was missing", () => {
    expect(() => must(undefined, "the frame's box")).toThrow("expected the frame's box");
    expect(() => must(null, "a match")).toThrow("expected a match");
  });
});
