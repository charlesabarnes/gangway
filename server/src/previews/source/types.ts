import path from "node:path";
import { AppError, type ErrorCode } from "../../errors.ts";

// A bare startsWith would accept /tmp/foobar as inside /tmp/foo.
export function containedIn(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export function resolveWithin(base: string, rel: string): string | undefined {
  const resolved = path.resolve(base, rel);
  return containedIn(base, resolved) ? resolved : undefined;
}

export type ExtractLimits = {
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxPathBytes?: number;
};

export type ResolvedLimits = Required<ExtractLimits>;

export const DEFAULT_LIMITS: ResolvedLimits = {
  maxEntries: 20_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxPathBytes: 255,
};

export function resolveLimits(l: ExtractLimits = {}): ResolvedLimits {
  return { ...DEFAULT_LIMITS, ...l };
}

export const FILE_MODE = 0o644;
export const DIR_MODE = 0o755;

export type TarballRejection =
  | "path_escape"
  | "absolute_path"
  | "path_traversal"
  | "link_escape"
  | "unsupported_entry_type"
  | "too_many_entries"
  | "file_too_large"
  | "archive_too_large"
  | "path_too_long"
  | "invalid_path"
  | "duplicate_entry"
  | "malformed_archive";

const REJECTION_STATUS: Record<TarballRejection, ErrorCode> = {
  path_escape: "unprocessable",
  absolute_path: "unprocessable",
  path_traversal: "unprocessable",
  link_escape: "unprocessable",
  unsupported_entry_type: "unprocessable",
  path_too_long: "unprocessable",
  invalid_path: "unprocessable",
  duplicate_entry: "unprocessable",
  malformed_archive: "unprocessable",
  too_many_entries: "payload_too_large",
  file_too_large: "payload_too_large",
  archive_too_large: "payload_too_large",
};

export class TarballError extends AppError {
  readonly reason: TarballRejection;

  constructor(reason: TarballRejection, message: string, entry?: string) {
    super(REJECTION_STATUS[reason], message, {
      reason,
      ...(entry === undefined ? {} : { entry: entry.slice(0, 120) }),
    });
    this.name = "TarballError";
    this.reason = reason;
  }
}

export const rejectTarball = (r: TarballRejection, m: string, entry?: string) =>
  new TarballError(r, m, entry);

export type ExtractResult = {
  entries: number;
  files: number;
  directories: number;
  links: number;
  totalBytes: number;
};

export type CloneRejection =
  | "invalid_repo_url"
  | "host_not_allowed"
  | "credentials_in_url"
  | "invalid_ref"
  | "clone_failed"
  | "clone_timeout";

const CLONE_STATUS: Record<CloneRejection, ErrorCode> = {
  invalid_repo_url: "bad_request",
  host_not_allowed: "forbidden",
  credentials_in_url: "bad_request",
  invalid_ref: "bad_request",
  clone_failed: "bad_gateway",
  clone_timeout: "upstream_timeout",
};

export class GitError extends AppError {
  readonly reason: CloneRejection;

  constructor(reason: CloneRejection, message: string, detail?: Record<string, unknown>) {
    super(CLONE_STATUS[reason], message, { reason, ...(detail ?? {}) });
    this.name = "GitError";
    this.reason = reason;
  }
}

export const rejectClone = (r: CloneRejection, m: string, d?: Record<string, unknown>) =>
  new GitError(r, m, d);
