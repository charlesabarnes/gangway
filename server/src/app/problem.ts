/**
 * Every error leaving the API is problem+json (RFC 9457), never a stack trace.
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { AppError, type ErrorCode } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { AppEnv } from "./env.ts";

const CODE_FOR_STATUS: Record<number, ErrorCode> = {
  400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
  409: "conflict", 413: "payload_too_large", 422: "unprocessable", 429: "rate_limited",
  502: "bad_gateway", 503: "unavailable", 504: "upstream_timeout",
};

export function problemResponse(c: Context<AppEnv>, err: AppError, headers: Record<string, string> = {}): Response {
  const body = { ...err.toProblem(new URL(c.req.url).pathname), requestId: c.get("requestId") };
  return new Response(JSON.stringify(body), {
    status: err.status,
    headers: { "content-type": "application/problem+json", ...(err.headers ?? {}), ...headers },
  });
}

export function toAppError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  if (e instanceof ZodError) {
    return new AppError("unprocessable", "request validation failed", {
      issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (e instanceof HTTPException) {
    const code = CODE_FOR_STATUS[e.status];
    if (code) return new AppError(code, e.message || code.replace(/_/g, " "));
  }
  return null;
}

export function errorHandler(logger: Logger) {
  return (e: unknown, c: Context<AppEnv>): Response => {
    const known = toAppError(e);
    if (known && known.status < 500) return problemResponse(c, known);
    // 5xx: the cause goes to the log, keyed by request id; the client gets no detail.
    logger.error("unhandled request error", {
      requestId: c.get("requestId"), method: c.req.method, path: new URL(c.req.url).pathname, err: e,
    });
    const shown = known ? new AppError(known.code, known.code.replace(/_/g, " ")) : new AppError("internal", "internal error");
    return problemResponse(c, shown);
  };
}
