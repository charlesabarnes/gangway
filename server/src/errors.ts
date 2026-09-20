/**
 * Error taxonomy. Every error crossing the API boundary becomes problem+json (RFC 9457),
 * never a stack trace -- preview visitors are untrusted and see these pages.
 */
export type ErrorCode =
  | "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict"
  | "payload_too_large" | "unprocessable" | "rate_limited"
  | "internal" | "bad_gateway" | "upstream_timeout" | "unavailable";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409,
  payload_too_large: 413, unprocessable: 422, rate_limited: 429,
  internal: 500, bad_gateway: 502, upstream_timeout: 504, unavailable: 503,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }

  toProblem(instance?: string) {
    return {
      type: `https://gangway.dev/errors/${this.code}`,
      title: this.code.replace(/_/g, " "),
      status: this.status,
      detail: this.message,
      ...(instance ? { instance } : {}),
      ...(this.detail ?? {}),
    };
  }
}

export const badRequest = (m: string, d?: Record<string, unknown>) => new AppError("bad_request", m, d);
export const notFound = (m: string, d?: Record<string, unknown>) => new AppError("not_found", m, d);
export const conflict = (m: string, d?: Record<string, unknown>) => new AppError("conflict", m, d);
export const unauthorized = (m = "authentication required") => new AppError("unauthorized", m);
export const forbidden = (m = "insufficient scope") => new AppError("forbidden", m);
export const internal = (m: string, d?: Record<string, unknown>) => new AppError("internal", m, d);
