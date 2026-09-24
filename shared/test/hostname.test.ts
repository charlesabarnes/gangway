import { describe, expect, test } from "bun:test";
import {
  RESERVED_LABELS,
  checkLabel,
  isValidLabel,
  normalizeHost,
  labelUnder,
  classifyHost,
  domainPairProblem,
  fqdn,
  slugify,
  buildLabel,
  type LabelRejection,
} from "../src/hostname.ts";

const BASE = "preview.example.com";

describe("normalizeHost", () => {
  test.each<[string | null | undefined, string | null]>([
    ["Foo.Preview.Example.COM", "foo.preview.example.com"],
    ["foo.preview.example.com.", "foo.preview.example.com"],
    ["foo.preview.example.com:8443", "foo.preview.example.com"],
    ["  foo.preview.example.com  ", "foo.preview.example.com"],
    ["FOO.preview.example.com.:443", "foo.preview.example.com"],
    ["[::1]:8443", "[::1]"],
    ["", null],
    [null, null],
    [undefined, null],
    ["foo_bar.preview.example.com", null],
    ["xn--e1afmkfd.example.com", "xn--e1afmkfd.example.com"],
    ["föö.example.com", null],
    ["a".repeat(254), null],
  ])("%j -> %j", (input, want) => {
    expect(normalizeHost(input)).toBe(want);
  });
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
    expect(checkLabel("api").ok).toBe(false);
    const built = buildLabel({ kind: "pr", repo: "api", number: 7 });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.label).toBe("api-pr-7");
  });

  test.each<[string, LabelRejection]>([
    ["", "empty"],
    ["-lead", "malformed"],
    ["trail-", "malformed"],
    ["Upper", "malformed"],
    ["under_score", "malformed"],
    ["has space", "malformed"],
    ["a.b", "contains-dot"],
    ["..", "contains-dot"],
    ["a".repeat(64), "too-long"],
  ])("rejects %j as %s", (label, reason) => {
    const r = checkLabel(label);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  test("63 chars is allowed, 64 is not", () => {
    expect(isValidLabel("a".repeat(63))).toBe(true);
    expect(isValidLabel("a".repeat(64))).toBe(false);
  });

  test("a dot is reported as a dot, not as generic malformation", () => {
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
  test("multi-label subdomains are refused", () => {
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
  test.each([
    [
      "the PR scheme",
      { kind: "pr", repo: "acme", number: 123 },
      { service: "api" },
      "acme-pr-123-api",
    ],
    ["the slug scheme", { kind: "slug", slug: "My App" }, { service: "web" }, "my-app-web"],
    [
      "a single-service stack",
      { kind: "pr", repo: "acme", number: 1 },
      { service: "web", isSingleService: true },
      "acme-pr-1",
    ],
    [
      "the primary service",
      { kind: "pr", repo: "acme", number: 1 },
      { service: "web", isPrimary: true },
      "acme-pr-1",
    ],
  ] as const)("%s", (_, source, opts, label) => {
    const r = buildLabel(source, opts);
    expect(r.ok && r.label).toBe(label);
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

describe("classifyHost", () => {
  const CONTROL = "gangway.example";
  const PREVIEWS = "gangway-preview.app";
  test.each<[string, string, string, string]>([
    ["one domain: apex is the app", "preview.example.com", BASE, "surface:"],
    ["one domain: a reserved label is a surface", "mcp.preview.example.com", BASE, "surface:mcp"],
    ["one domain: any other label is a preview", "acme-pr-1.preview.example.com", BASE, "preview"],
    ["one domain: a foreign host", "evil.com", BASE, "misdirected"],
    ["two domains: control apex", CONTROL, PREVIEWS, "surface:"],
    ["two domains: control surface", "app.gangway.example", PREVIEWS, "surface:app"],
    ["two domains: a preview", "acme-pr-1.gangway-preview.app", PREVIEWS, "preview"],
    [
      "two domains: surfaces never answer on the preview domain",
      "app.gangway-preview.app",
      PREVIEWS,
      "unknown",
    ],
    ["two domains: the preview apex", PREVIEWS, PREVIEWS, "unknown"],
    [
      "two domains: an older preview under the control domain",
      "old.gangway.example",
      PREVIEWS,
      "preview",
    ],
    ["two domains: a foreign host", "evil.com", PREVIEWS, "misdirected"],
  ])("%s", (_, host, previewDomain, want) => {
    const control = previewDomain === BASE ? BASE : CONTROL;
    const k = classifyHost(host, control, previewDomain);
    expect(k.kind === "surface" ? `surface:${k.label}` : k.kind).toBe(want);
  });

  test("a preview domain nested under the control domain", () => {
    const nested = "previews.gangway.example";
    expect(classifyHost("x.previews.gangway.example", "gangway.example", nested).kind).toBe(
      "preview",
    );
    expect(classifyHost("app.previews.gangway.example", "gangway.example", nested).kind).toBe(
      "unknown",
    );
    expect(classifyHost("app.gangway.example", "gangway.example", nested).kind).toBe("surface");
  });
});

describe("domainPairProblem", () => {
  test.each<[string, string, boolean]>([
    ["preview.example.com", "preview.example.com", false],
    ["gangway.example", "gangway-preview.app", false],
    ["gangway.example", "previews.gangway.example", false],
    ["gw.example.com", "example.com", true],
  ])("%s with %s", (control, preview, problem) => {
    expect(domainPairProblem(control, preview) !== null).toBe(problem);
  });
});
