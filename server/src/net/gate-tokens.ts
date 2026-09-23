import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RouteEntry } from "../routing/table.ts";

export const GATE_COOKIE = "__Host-gw_pv";
export const PASSWORD_COOKIE = "__Host-gw_pw";

export type TokenOptions = {
  key: Buffer;
  now: () => number;
  ticketTtlMs: number;
  cookieTtlMs: number;
  passwordCookieTtlMs: number;
};

type Kind = "ticket" | "cookie" | "password";
type TicketBody = { h: string; p: string; exp: number; n: string; s?: 1 };
export type GateCookie = { valid: boolean; skip: boolean };

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function cookieValues(req: Request, name: string): string[] {
  const header = req.headers.get("cookie");
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    values.push(part.slice(eq + 1).trim());
  }
  return values;
}

export class GateTokens {
  readonly #o: TokenOptions;
  readonly #used = new Map<string, number>();

  constructor(o: TokenOptions) {
    this.#o = o;
  }

  #mac(kind: Kind, payload: string): Buffer {
    return createHmac("sha256", this.#o.key).update(`${kind}|${payload}`).digest();
  }

  #verify(kind: Kind, payload: string, sig: string): boolean {
    const given = Buffer.from(sig, "base64url");
    const want = this.#mac(kind, payload);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  issueTicket(
    entry: Pick<RouteEntry, "hostname" | "previewId">,
    o: { skipPassword?: boolean } = {},
  ): string {
    const body: TicketBody = {
      h: entry.hostname,
      p: entry.previewId,
      exp: this.#o.now() + this.#o.ticketTtlMs,
      n: randomBytes(12).toString("base64url"),
      ...(o.skipPassword ? { s: 1 as const } : {}),
    };
    const payload = b64(JSON.stringify(body));
    return `${payload}.${b64(this.#mac("ticket", payload))}`;
  }

  redeem(ticket: string, entry: RouteEntry): TicketBody | null {
    const [payload, sig, extra] = ticket.split(".");
    if (!payload || !sig || extra !== undefined || !this.#verify("ticket", payload, sig))
      return null;
    let body: TicketBody;
    try {
      body = JSON.parse(Buffer.from(payload, "base64url").toString()) as TicketBody;
    } catch {
      return null;
    }
    const now = this.#o.now();
    if (body.exp <= now || body.h !== entry.hostname || body.p !== entry.previewId) return null;
    if (this.#used.has(body.n)) return null;
    for (const [n, exp] of this.#used) if (exp <= now) this.#used.delete(n);
    this.#used.set(body.n, body.exp);
    return body;
  }

  gateSetCookie(entry: RouteEntry, skip: boolean): string {
    const payload = `${entry.previewId}.${this.#o.now() + this.#o.cookieTtlMs}.${skip ? 1 : 0}`;
    const value = `${payload}.${b64(this.#mac("cookie", payload))}`;
    return `${GATE_COOKIE}=${value}; Max-Age=${Math.floor(this.#o.cookieTtlMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }

  gateCookie(req: Request, entry: RouteEntry): GateCookie {
    const out = { valid: false, skip: false };
    for (const value of cookieValues(req, GATE_COOKIE)) {
      const fields = value.split(".");
      if (fields.length !== 3 && fields.length !== 4) continue;
      const sig = fields.pop()!;
      const [previewId, exp, skip] = fields;
      if (!previewId || !exp || previewId !== entry.previewId || !(Number(exp) > this.#o.now()))
        continue;
      if (!this.#verify("cookie", fields.join("."), sig)) continue;
      out.valid = true;
      if (skip === "1") out.skip = true;
    }
    return out;
  }

  passwordSetCookie(entry: RouteEntry, fp: string): string {
    const payload = `${entry.previewId}.${this.#o.now() + this.#o.passwordCookieTtlMs}.${fp}`;
    const value = `${payload}.${b64(this.#mac("password", payload))}`;
    return `${PASSWORD_COOKIE}=${value}; Max-Age=${Math.floor(this.#o.passwordCookieTtlMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }

  hasPasswordCookie(req: Request, entry: RouteEntry, fp: string): boolean {
    for (const value of cookieValues(req, PASSWORD_COOKIE)) {
      const [previewId, exp, cfp, sig, extra] = value.split(".");
      if (!previewId || !exp || !cfp || !sig || extra !== undefined) continue;
      if (
        previewId === entry.previewId &&
        cfp === fp &&
        Number(exp) > this.#o.now() &&
        this.#verify("password", `${previewId}.${exp}.${cfp}`, sig)
      )
        return true;
    }
    return false;
  }
}
