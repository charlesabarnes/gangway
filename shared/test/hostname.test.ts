import { describe, expect, test } from "bun:test";
import {
  RESERVED_LABELS, checkLabel, isValidLabel, normalizeHost, labelUnder,
  fqdn, slugify, buildLabel, type LabelRejection,
} from "../src/hostname.ts";

const BASE = "preview.example.com";

describe("normalizeHost", () => {
  const cases: [string | null | undefined, string | null][] = [
    ["Foo.Preview.Example.COM", "foo.preview.example.com"],   // uppercase
    ["foo.preview.example.com.", "foo.preview.example.com"],  // trailing dot
    ["foo.preview.example.com:8443", "foo.preview.example.com"], // port
    ["  foo.preview.example.com  ", "foo.preview.example.com"],  // whitespace
    ["FOO.preview.example.com.:443", "foo.preview.example.com"], // all three
    ["[::1]:8443", "[::1]"],                                   // IPv6 literal
    ["", null], [null, null], [undefined, null],
    ["foo_bar.preview.example.com", null],                     // underscore
    ["xn--e1afmkfd.example.com", "xn--e1afmkfd.example.com"],   // punycode is fine
    ["föö.example.com", null],                                 // raw IDN rejected
    ["a".repeat(254), null],                                   // over 253
  ];
  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => {
      expect(normalizeHost(input)).toBe(want);
    });
  }
});

describe("checkLabel", () => {
  test("accepts ordinary labels", () => {
    for (const l of ["web", "acme-pr-123", "acme-pr-123-api", "a", "a1", "x-9"]) {
      expect(isValidLabel(l)).toBe(true);
    }
  });

  test.each([...RESERVED_LABELS])("rejects reserved label %s", (label) => {
    const r = checkLabel(label);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reserved");
  });

  test("a PR on a repo literally named `api` cannot hijack the control plane", () => {
    // The bare repo label collides and must be refused...
    expect(checkLabel("api").ok).toBe(false);
    // ...but the PR-scoped label is distinct and therefore fine.
    const built = buildLabel({ kind: "pr", repo: "api", number: 7 });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.label).toBe("api-pr-7");
  });

  const bad: [string, LabelRejection][] = [
    ["", "empty"],
    ["-lead", "malformed"],
    ["trail-", "malformed"],
    ["Upper", "malformed"],
    ["under_score", "malformed"],
    ["has space", "malformed"],
    ["a.b", "contains-dot"],
    ["..", "contains-dot"],
    ["a".repeat(64), "too-long"],
  ];
  for (const [label, reason] of bad) {
    test(`rejects ${JSON.stringify(label)} (${reason})`, () => {
      const r = checkLabel(label);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    });
  }

  test("63 chars is allowed, 64 is not", () => {
    expect(isValidLabel("a".repeat(63))).toBe(true);
    expect(isValidLabel("a".repeat(64))).toBe(false);
  });

  test("a dot is reported as a dot, not as generic malformation", () => {
    // This distinction matters: it is the one-wildcard-label rule, and the error
    // text has to explain why `api.acme-pr-1` cannot work.
    const r = checkLabel("api.acme-pr-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("contains-dot");
      expect(r.message).toContain("one label");
    }
  });
});

describe("labelUnder", () => {
  test("extracts a single label", () => {
    expect(labelUnder("acme-pr-1.preview.example.com", BASE)).toBe("acme-pr-1");
  });
  test("the apex itself yields the empty label", () => {
    expect(labelUnder(BASE, BASE)).toBe("");
  });
  test("multi-label subdomains are refused (no wildcard covers them)", () => {
    expect(labelUnder("api.acme-pr-1.preview.example.com", BASE)).toBeNull();
  });
  test("foreign domains are refused", () => {
    expect(labelUnder("evil.com", BASE)).toBeNull();
    expect(labelUnder("preview.example.com.evil.com", BASE)).toBeNull();
  });
  test("a suffix that is not a label boundary is refused", () => {
    expect(labelUnder("notpreview.example.com", BASE)).toBeNull();
  });
  test("round-trips with fqdn", () => {
    expect(labelUnder(fqdn("web", BASE), BASE)).toBe("web");
  });
});

describe("slugify", () => {
  test.each([
    ["Acme Corp", "acme-corp"],
    ["my_repo.name", "my-repo-name"],
    ["--lead-and-trail--", "lead-and-trail"],
    ["Ünïcødé", "n-c-d"],
  ])("%s -> %s", (a, b) => expect(slugify(a)).toBe(b));
});

describe("buildLabel", () => {
  test("PR scheme", () => {
    const r = buildLabel({ kind: "pr", repo: "acme", number: 123 }, { service: "api" });
    expect(r.ok && r.label).toBe("acme-pr-123-api");
  });
  test("slug scheme", () => {
    const r = buildLabel({ kind: "slug", slug: "My App" }, { service: "web" });
    expect(r.ok && r.label).toBe("my-app-web");
  });
  test("single-service stacks drop the service segment", () => {
    const r = buildLabel({ kind: "pr", repo: "acme", number: 1 }, { service: "web", isSingleService: true });
    expect(r.ok && r.label).toBe("acme-pr-1");
  });
  test("the primary service drops the service segment", () => {
    const r = buildLabel({ kind: "pr", repo: "acme", number: 1 }, { service: "web", isPrimary: true });
    expect(r.ok && r.label).toBe("acme-pr-1");
  });
  test("rejects rather than silently truncating an over-long label", () => {
    const r = buildLabel({ kind: "pr", repo: "a".repeat(70), number: 1 }, { service: "api" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too-long");
  });
  test("a generated label that lands on a reserved word is refused", () => {
    const r = buildLabel({ kind: "slug", slug: "www" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reserved");
  });
  test("every generated label is a legal DNS label", () => {
    for (const n of [1, 42, 999]) {
      for (const repo of ["acme", "My-Project", "a.b.c"]) {
        const r = buildLabel({ kind: "pr", repo, number: n }, { service: "api" });
        if (r.ok) expect(isValidLabel(r.label)).toBe(true);
      }
    }
  });
});
