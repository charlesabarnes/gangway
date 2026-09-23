import { describe, expect, test } from "bun:test";
import { publicOriginFor, publicUrlFor } from "../src/url.ts";

describe("publicUrlFor", () => {
  test("elides the default port for https", () => {
    expect(publicOriginFor("x.preview.example.com", { scheme: "https", port: 443 })).toBe(
      "https://x.preview.example.com",
    );
  });
  test("elides the default port for http", () => {
    expect(publicOriginFor("x.example.com", { scheme: "http", port: 80 })).toBe(
      "http://x.example.com",
    );
  });
  test("keeps a non-default port", () => {
    expect(publicOriginFor("x.preview.localhost", { scheme: "https", port: 8443 })).toBe(
      "https://x.preview.localhost:8443",
    );
  });
  test("never emits :443 in production", () => {
    const url = publicUrlFor("acme-pr-1.preview.example.com", { scheme: "https", port: 443 });
    expect(url).not.toContain(":443");
    expect(url).toBe("https://acme-pr-1.preview.example.com/");
  });
  test("normalises a path without a leading slash", () => {
    expect(publicUrlFor("h", { scheme: "https", port: 443 }, "setup/abc")).toBe(
      "https://h/setup/abc",
    );
  });
  test("443 on http is not treated as default", () => {
    expect(publicOriginFor("h", { scheme: "http", port: 443 })).toBe("http://h:443");
  });
});
