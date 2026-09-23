/**
 * Hostname scheme and label rules (spec §6.2, §6.2.1).
 *
 * The wildcard certificate `*.preview.example.com` matches EXACTLY ONE label, which is
 * the constraint everything here exists to enforce:
 *   ok   acme-pr-123-api.preview.example.com
 *   no   api.acme-pr-123.preview.example.com   <- needs a per-PR wildcard, hits ACME rate limits
 *
 * This module is shared verbatim with the Angular app so both sides agree on what a
 * legal preview hostname is.
 */

/**
 * Subdomains the system owns. A PR on a repo named `api` must not be able to hijack the
 * control plane.
 *
 * This list is STATIC and independent of which surfaces are currently enabled (§6.2.1):
 * if `mcp` became a valid preview label while MCP was switched off, re-enabling it later
 * would collide with a live preview.
 */
export const RESERVED_LABELS: ReadonlySet<string> = new Set([
  "app",
  "api",
  "mcp",
  "hooks",
  "registry",
  "www",
]);

/** A single DNS label: 1-63 chars, a-z 0-9 and hyphen, never leading or trailing hyphen. */
export const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const MAX_LABEL_LENGTH = 63;

export type LabelRejection = "empty" | "too-long" | "contains-dot" | "malformed" | "reserved";

export type LabelCheck = { ok: true } | { ok: false; reason: LabelRejection; message: string };

/** Validates a preview label. Reserved labels are rejected here, at registration time. */
export function checkLabel(label: string): LabelCheck {
  if (label.length === 0) return { ok: false, reason: "empty", message: "hostname label is empty" };
  if (label.includes("."))
    return {
      ok: false,
      reason: "contains-dot",
      message: `label "${label}" contains a dot; the wildcard certificate matches only one label`,
    };
  if (label.length > MAX_LABEL_LENGTH)
    return {
      ok: false,
      reason: "too-long",
      message: `label is ${label.length} characters; the DNS limit is ${MAX_LABEL_LENGTH}`,
    };
  if (!LABEL_RE.test(label))
    return {
      ok: false,
      reason: "malformed",
      message: `label "${label}" must be lowercase alphanumeric with interior hyphens only`,
    };
  if (RESERVED_LABELS.has(label))
    return { ok: false, reason: "reserved", message: `"${label}" is a reserved system subdomain` };
  return { ok: true };
}

export function isValidLabel(label: string): boolean {
  return checkLabel(label).ok;
}

/**
 * Normalizes an incoming Host header for lookup: lowercase, no port, no trailing dot.
 * Returns null for anything that cannot be a hostname, so the caller answers 400.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[")) {
    // IPv6 literal — never a preview host, but must not be mangled into one.
    const end = h.indexOf("]");
    if (end < 0) return null;
    h = h.slice(0, end + 1);
    return h;
  }
  const colon = h.lastIndexOf(":");
  if (colon > -1) h = h.slice(0, colon);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) return null; // rejects IDN-unsafe and control characters
  return h;
}

/**
 * Returns the single label under `baseDomain`, or null when `host` is not a direct
 * subdomain of it. Multi-label subdomains return null by design — they cannot be covered
 * by the wildcard certificate.
 */
export function labelUnder(host: string, baseDomain: string): string | null {
  const base = baseDomain.toLowerCase().replace(/\.$/, "");
  if (host === base) return "";
  if (!host.endsWith("." + base)) return null;
  const label = host.slice(0, host.length - base.length - 1);
  if (label.includes(".")) return null;
  return label;
}

export function fqdn(label: string, baseDomain: string): string {
  return `${label}.${baseDomain.toLowerCase().replace(/\.$/, "")}`;
}

/** Lowercase, collapse anything not [a-z0-9] to a hyphen, trim hyphens. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type LabelSource =
  { kind: "pr"; repo: string; number: number } | { kind: "slug"; slug: string };

/**
 * Builds a preview label. The service segment is dropped for single-service stacks and
 * for the service marked `primary` (§6.2), so the common case is a short, bare hostname.
 *
 * Deliberately REJECTS rather than silently truncating when the result exceeds the DNS
 * limit — silent truncation collides across PRs. (§15.5, truncate-with-hash vs a required
 * short slug, is decided in Phase 3; until then the error names the problem.)
 */
export function buildLabel(
  source: LabelSource,
  opts: { service?: string; isPrimary?: boolean; isSingleService?: boolean } = {},
): { ok: true; label: string } | { ok: false; reason: LabelRejection; message: string } {
  const stem =
    source.kind === "pr" ? `${slugify(source.repo)}-pr-${source.number}` : slugify(source.slug);

  const dropService = opts.isPrimary === true || opts.isSingleService === true || !opts.service;
  const label = dropService ? stem : `${stem}-${slugify(opts.service!)}`;

  const check = checkLabel(label);
  if (!check.ok) return { ok: false, reason: check.reason, message: check.message };
  return { ok: true, label };
}
