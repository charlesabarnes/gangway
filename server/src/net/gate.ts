/**
 * §8.3 the `private` visibility gate: "requires a valid session. The proxy redirects to
 * the UI login and back."
 *
 * The obvious way to do that is WRONG. The session cookie lives on `app.<base>`; a preview
 * lives on `<name>.<base>`. Widening the cookie to `.<base>` so the proxy could read it
 * would hand the operator's session to every preview container -- and a preview is, by
 * definition, somebody else's code. So the session never leaves `app`, and a preview gets
 * a credential of its own, good for that one preview:
 *
 *   1. GET https://shop.<base>/x          no gate cookie -> 302 to app's /v1/auth/gate?return=…
 *   2. app checks the SESSION and the `previews.view_private` permission, and mints a
 *      TICKET: HMAC-signed, 60 seconds, single use, bound to this hostname AND preview id.
 *   3. GET https://shop.<base>/__gangway/auth?ticket=…&to=/x
 *      -> Set-Cookie __Host-gw_pv (host-only, HttpOnly, signed, 8 h), 302 to /x
 *   4. GET https://shop.<base>/x          cookie verifies -> proxied.
 *
 * What the preview's own code can never see: the gate cookie is stripped from the request
 * before it is forwarded (net/headers.ts, and the WebSocket leg), and `/__gangway/*` is
 * never forwarded, for ANY preview. The ticket rides in a URL, which is why it is
 * single-use and short-lived: by the time it is in a log or a Referer it is dead.
 *
 * Bound to the preview ID, not just the hostname: destroy `shop` and deploy a new `shop`,
 * and an old cookie does not open the new one.
 *
 * Pure: no Hono, no database, no await. The hot path is one HMAC over a cookie.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RouteEntry } from "../routing/table.ts";

export const GATE_COOKIE = "__Host-gw_pv";
export const GATE_PREFIX = "/__gangway/";
const AUTH_PATH = "/__gangway/auth";

export type GateOptions = {
  /** 32 random bytes, stable across restarts (or every visitor re-authenticates on each one). */
  key: Buffer;
  /** `https://app.<base>` -- where the session lives. Read per request: the base domain is a setting. */
  appOrigin: () => string;
  now?: () => number;
  ticketTtlMs?: number;
  cookieTtlMs?: number;
};

type TicketBody = { h: string; p: string; exp: number; n: string };

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Only ever a same-origin PATH: `to` arrives in a URL, and this is a redirect. */
export function safePath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.startsWith(GATE_PREFIX)) return "/";
  return /[\x00-\x1f]/.test(raw) ? "/" : raw;
}

export class PreviewGate {
  readonly #o: Required<GateOptions>;
  /** Tickets already spent, until they would have expired anyway. */
  readonly #used = new Map<string, number>();

  constructor(o: GateOptions) {
    if (o.key.length < 32) throw new Error("the gate key must be at least 32 bytes");
    this.#o = { now: Date.now, ticketTtlMs: 60_000, cookieTtlMs: 8 * 3_600_000, ...o };
  }

  /** Domain-separated, so a cookie can never be replayed as a ticket or the reverse. */
  #mac(kind: "ticket" | "cookie", payload: string): Buffer {
    return createHmac("sha256", this.#o.key).update(`${kind}|${payload}`).digest();
  }

  #verify(kind: "ticket" | "cookie", payload: string, sig: string): boolean {
    const given = Buffer.from(sig, "base64url");
    const want = this.#mac(kind, payload);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  /** Called by the app surface AFTER it has checked the session and the permission. */
  issueTicket(entry: Pick<RouteEntry, "hostname" | "previewId">): string {
    const body: TicketBody = { h: entry.hostname, p: entry.previewId, exp: this.#o.now() + this.#o.ticketTtlMs, n: randomBytes(12).toString("base64url") };
    const payload = b64(JSON.stringify(body));
    return `${payload}.${b64(this.#mac("ticket", payload))}`;
  }

  #redeem(ticket: string, entry: RouteEntry): boolean {
    const [payload, sig, extra] = ticket.split(".");
    if (!payload || !sig || extra !== undefined || !this.#verify("ticket", payload, sig)) return false;
    let body: TicketBody;
    try { body = JSON.parse(Buffer.from(payload, "base64url").toString()) as TicketBody; } catch { return false; }
    const now = this.#o.now();
    if (body.exp <= now || body.h !== entry.hostname || body.p !== entry.previewId) return false;
    if (this.#used.has(body.n)) return false;
    for (const [n, exp] of this.#used) if (exp <= now) this.#used.delete(n);
    this.#used.set(body.n, body.exp);
    return true;
  }

  #cookieFor(entry: RouteEntry): string {
    const payload = `${entry.previewId}.${this.#o.now() + this.#o.cookieTtlMs}`;
    return `${payload}.${b64(this.#mac("cookie", payload))}`;
  }

  #hasValidCookie(req: Request, entry: RouteEntry): boolean {
    const header = req.headers.get("cookie");
    if (!header) return false;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0 || part.slice(0, eq).trim() !== GATE_COOKIE) continue;
      const [previewId, exp, sig, extra] = part.slice(eq + 1).trim().split(".");
      if (!previewId || !exp || !sig || extra !== undefined) continue;
      if (previewId === entry.previewId && Number(exp) > this.#o.now() && this.#verify("cookie", `${previewId}.${exp}`, sig)) return true;
    }
    return false;
  }

  /**
   * The dispatcher's hook (and the WebSocket path's). null means "let it through".
   * `/__gangway/*` is answered here for EVERY preview, so the prefix can never reach an
   * upstream and a preview cannot serve a convincing fake of it.
   */
  readonly check = (entry: RouteEntry, req: Request): Response | null => {
    // The hot path: a public preview, an ordinary path. No URL parse, no HMAC.
    if (entry.visibility !== "private" && !req.url.includes("/__gangway")) return null;
    const url = new URL(req.url);

    if (url.pathname.startsWith(GATE_PREFIX) || url.pathname === GATE_PREFIX.slice(0, -1)) {
      if (entry.visibility !== "private" || url.pathname !== AUTH_PATH || req.method !== "GET") return plain(404, "not found");
      if (!this.#redeem(url.searchParams.get("ticket") ?? "", entry)) {
        return plain(403, "This sign-in link has expired or was already used. Open the preview again to get a new one.");
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: safePath(url.searchParams.get("to")),
          "set-cookie": `${GATE_COOKIE}=${this.#cookieFor(entry)}; Max-Age=${Math.floor(this.#o.cookieTtlMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
          // The ticket is in this URL. Do not let the next page's requests carry it onward.
          "referrer-policy": "no-referrer",
        },
      });
    }

    if (entry.visibility !== "private" || this.#hasValidCookie(req, entry)) return null;

    // Only a top-level page load can usefully be sent to log in. A fetch, an <img>, a
    // WebSocket or a POST cannot follow a cross-origin redirect to an HTML login page and
    // come back -- tell those plainly instead.
    const mode = req.headers.get("sec-fetch-mode");
    const navigation = (req.method === "GET" || req.method === "HEAD") && !req.headers.has("upgrade") && (mode === null || mode === "navigate");
    if (!navigation) return plain(401, "This preview is private. Open it in a browser tab and log in first.");

    const back = `${url.pathname}${url.search}`;
    const target = new URL("/v1/auth/gate", this.#o.appOrigin());
    target.searchParams.set("host", entry.hostname);
    target.searchParams.set("to", safePath(back));
    return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
  };
}

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

/**
 * Removes gangway's own cookies from a Cookie header bound for a preview. Everything named
 * `__Host-gw_*`: the gate cookie above, and -- belt and braces, a browser would never send
 * it to this host -- the session cookie. Returns null when nothing is left.
 */
export function stripGangwayCookies(header: string | null | undefined): string | null {
  if (!header) return null;
  const kept = header.split(";").map((p) => p.trim()).filter((p) => p !== "" && !p.startsWith("__Host-gw_"));
  return kept.length > 0 ? kept.join("; ") : null;
}

/** The gate key lives with everything else that must survive a restart and ride in a backup. */
export function loadOrCreateGateKey(store: { get(key: string): unknown; set(key: string, value: unknown): void }): Buffer {
  const KEY = "auth.gateKey";
  const stored = store.get(KEY);
  if (typeof stored === "string") {
    const key = Buffer.from(stored, "base64");
    if (key.length >= 32) return key;
  }
  const key = randomBytes(32);
  store.set(KEY, key.toString("base64"));
  return key;
}
