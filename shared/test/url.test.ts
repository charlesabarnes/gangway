import { describe, expect, test } from "bun:test";
import { publicOriginFor, publicUrlFor } from "../src/url.ts";

describe("publicOriginFor", () => {
  test.each([
    ["https", 443, "x.preview.example.com", "https://x.preview.example.com"],
    ["http", 80, "x.example.com", "http://x.example.com"],
    ["https", 8443, "x.preview.localhost", "https://x.preview.localhost:8443"],
    ["http", 443, "h", "http://h:443"],
  ] as const)("%s on port %d", (scheme, port, host, origin) => {
    expect(publicOriginFor(host, { scheme, port })).toBe(origin);
  });
});

describe("publicUrlFor", () => {
  test("never emits :443 in production", () => {
    expect(publicUrlFor("acme-pr-1.preview.example.com", { scheme: "https", port: 443 })).toBe(
      "https://acme-pr-1.preview.example.com/",
    );
  });

  test("normalises a path without a leading slash", () => {
    expect(publicUrlFor("h", { scheme: "https", port: 443 }, "setup/abc")).toBe(
      "https://h/setup/abc",
    );
  });
});
