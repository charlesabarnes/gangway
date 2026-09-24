// Reserved even when a surface is off, so re-enabling it cannot collide with a live preview.
export const RESERVED_LABELS: ReadonlySet<string> = new Set([
  "app",
  "api",
  "mcp",
  "hooks",
  "registry",
  "www",
]);

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const MAX_LABEL_LENGTH = 63;

export type LabelRejection = "empty" | "too-long" | "contains-dot" | "malformed" | "reserved";

export type LabelCheck = { ok: true } | { ok: false; reason: LabelRejection; message: string };

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

export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0) return null;
    h = h.slice(0, end + 1);
    return h;
  }
  const colon = h.lastIndexOf(":");
  if (colon > -1) h = h.slice(0, colon);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  return h;
}

export function labelUnder(host: string, baseDomain: string): string | null {
  const base = baseDomain.toLowerCase().replace(/\.$/, "");
  if (host === base) return "";
  if (!host.endsWith("." + base)) return null;
  const label = host.slice(0, host.length - base.length - 1);
  if (label.includes(".")) return null;
  return label;
}

export type HostKind =
  | { kind: "surface"; label: string }
  | { kind: "preview" }
  | { kind: "unknown" }
  | { kind: "misdirected" };

// Surfaces only ever answer under the control domain. Non-surface hosts there stay previews, so
// previews named before a preview domain was set keep answering until they expire.
export function classifyHost(host: string, controlDomain: string, previewDomain: string): HostKind {
  const control = labelUnder(host, controlDomain);
  if (control === "" || (control !== null && RESERVED_LABELS.has(control)))
    return { kind: "surface", label: control };
  const preview = labelUnder(host, previewDomain);
  if (preview !== null && preview !== "" && !RESERVED_LABELS.has(preview))
    return { kind: "preview" };
  if (control !== null) return { kind: "preview" };
  if (preview !== null) return { kind: "unknown" };
  return { kind: "misdirected" };
}

export function domainPairProblem(controlDomain: string, previewDomain: string): string | null {
  const control = controlDomain.toLowerCase().replace(/\.$/, "");
  const preview = previewDomain.toLowerCase().replace(/\.$/, "");
  if (control === preview) return null;
  // `gw.example.com` under preview domain `example.com` is also the name of a preview called `gw`.
  if (labelUnder(control, preview) !== null)
    return `the control domain ${control} is a name under the preview domain ${preview}; choose domains that are not nested that way`;
  return null;
}

export function fqdn(label: string, baseDomain: string): string {
  return `${label}.${baseDomain.toLowerCase().replace(/\.$/, "")}`;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type LabelSource =
  { kind: "pr"; repo: string; number: number } | { kind: "slug"; slug: string };

export function buildLabel(
  source: LabelSource,
  opts: { service?: string; isPrimary?: boolean; isSingleService?: boolean } = {},
): { ok: true; label: string } | { ok: false; reason: LabelRejection; message: string } {
  const stem =
    source.kind === "pr" ? `${slugify(source.repo)}-pr-${source.number}` : slugify(source.slug);

  const dropService = opts.isPrimary === true || opts.isSingleService === true || !opts.service;
  const label = dropService ? stem : `${stem}-${slugify(opts.service!)}`;

  // Too long is rejected, never truncated: truncation would collide across PRs.
  const check = checkLabel(label);
  if (!check.ok) return { ok: false, reason: check.reason, message: check.message };
  return { ok: true, label };
}
