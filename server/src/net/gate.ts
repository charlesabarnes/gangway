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
 * No Hono, no database. The hot path is one HMAC over a cookie; the only await is the
 * password form's POST (below).
 *
 * ADR-0023, the PASSWORD gate, checked after the private one. A preview behind a password
 * (its own, or the server-wide shared one when it inherits) answers a page load with a
 * form served by gangway, never by the preview. The form POSTs to `/__gangway/password`;
 * the right password earns `__Host-gw_pw`, signed and bound to the preview id AND a
 * fingerprint of the password hash -- change the password and every cookie for the old one
 * stops working. Stripped before forwarding like the other (`__Host-gw_*`).
 *
 * Signed in instead of the password: when a gangway login may get past a preview's
 * password (the preview says `on`, or `inherit` and the server-wide switch is on), a page
 * load with neither cookie first goes through app's /v1/auth/gate -- the same handshake as
 * a private preview. Signed in with `previews.skip_password`, the ticket says so and the
 * gate cookie it earns carries that; not signed in (or without the permission), app sends
 * the browser straight back to `/__gangway/password`, which shows the form. One bounce per
 * browser, never a login page for a stranger.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sourceKey, type LoginLimiter } from "../auth/limiter.ts";
import type { Passwords } from "../auth/password.ts";
import type { EntryPassword, RouteEntry } from "../routing/table.ts";

export const GATE_COOKIE = "__Host-gw_pv";
export const PASSWORD_COOKIE = "__Host-gw_pw";
const PASSWORD_PATH = "/__gangway/password";
/** The form's body is one password and one path: anything bigger is not the form. */
const MAX_FORM_BYTES = 8 * 1024;
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
  /** ADR-0023: how long a correct password is remembered. Default 7 days. */
  passwordCookieTtlMs?: number;
  /** The server-wide shared password, read per request; null when the default is not `shared`. */
  sharedPassword?: () => { hash: string; salt: string } | null;
  /** Verifies a submitted password. Absent: password-protected previews cannot be opened. */
  passwords?: Pick<Passwords, "verify">;
  /** Guessing limits, per source address and per preview. */
  limiter?: Pick<LoginLimiter, "check" | "fail" | "succeed">;
  /** A failed or throttled attempt, for the operator's log. */
  onPasswordFailure?: (entry: RouteEntry, clientIp: string, reason: "wrong" | "throttled") => void;
  /** The server-wide switch for previews whose `passwordLogin` is `inherit`, read per request. */
  loginDefault?: () => boolean;
};

type ResolvedOptions = Required<Omit<GateOptions, "passwords" | "limiter" | "onPasswordFailure">> &
  Pick<GateOptions, "passwords" | "limiter" | "onPasswordFailure">;
type Secret = { hash: string; salt: string; fp: string };

/** `s`: the visitor may skip this preview's password (signed in with `previews.skip_password`). */
type TicketBody = { h: string; p: string; exp: number; n: string; s?: 1 };

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Only ever a same-origin PATH: `to` arrives in a URL, and this is a redirect. */
export function safePath(raw: string | null | undefined): string {
  if (
    !raw ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.startsWith("/\\") ||
    raw.startsWith(GATE_PREFIX)
  )
    return "/";
  return /[\x00-\x1f]/.test(raw) ? "/" : raw;
}

export class PreviewGate {
  readonly #o: ResolvedOptions;
  /** Fingerprints by hash: one sha256 per password, not per request. */
  readonly #fps = new Map<string, string>();
  /** Tickets already spent, until they would have expired anyway. */
  readonly #used = new Map<string, number>();

  constructor(o: GateOptions) {
    if (o.key.length < 32) throw new Error("the gate key must be at least 32 bytes");
    this.#o = {
      now: Date.now,
      ticketTtlMs: 60_000,
      cookieTtlMs: 8 * 3_600_000,
      passwordCookieTtlMs: 7 * 24 * 3_600_000,
      sharedPassword: () => null,
      loginDefault: () => false,
      ...o,
    };
  }

  /** Domain-separated, so a cookie can never be replayed as a ticket or the reverse. */
  #mac(kind: "ticket" | "cookie" | "password", payload: string): Buffer {
    return createHmac("sha256", this.#o.key).update(`${kind}|${payload}`).digest();
  }

  #verify(kind: "ticket" | "cookie" | "password", payload: string, sig: string): boolean {
    const given = Buffer.from(sig, "base64url");
    const want = this.#mac(kind, payload);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  /** Called by the app surface AFTER it has checked the session and the permission. */
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

  /** The ticket's body when it is good for this entry (and now spent), else null. */
  #redeem(ticket: string, entry: RouteEntry): TicketBody | null {
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

  /** `previewId.exp.skip.sig`: `skip` is 1 when the ticket said the visitor may skip the password. */
  #cookieFor(entry: RouteEntry, skip: boolean): string {
    const payload = `${entry.previewId}.${this.#o.now() + this.#o.cookieTtlMs}.${skip ? 1 : 0}`;
    return `${payload}.${b64(this.#mac("cookie", payload))}`;
  }

  /** Signed in for this preview at all, and whether that sign-in may skip its password. */
  #gateCookie(req: Request, entry: RouteEntry): { valid: boolean; skip: boolean } {
    const header = req.headers.get("cookie");
    const out = { valid: false, skip: false };
    if (!header) return out;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0 || part.slice(0, eq).trim() !== GATE_COOKIE) continue;
      const fields = part
        .slice(eq + 1)
        .trim()
        .split(".");
      // Three fields: a cookie from before ADR-0023, which never skips a password.
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

  /** Does a gangway login get past this preview's password right now? */
  #loginSkips(entry: RouteEntry): boolean {
    const login = entry.passwordLogin ?? "inherit";
    return login === "on" || (login === "inherit" && this.#o.loginDefault());
  }

  /**
   * For app's /v1/auth/gate: may this host be sent a ticket at all -- private, or behind a
   * password a gangway login gets past. Anything else, and the gate is not an open redirect.
   */
  gateable(entry: RouteEntry): { private: boolean; passwordSkippable: boolean } {
    return {
      private: isPrivate(entry),
      passwordSkippable: this.#secretFor(entry) !== null && this.#loginSkips(entry),
    };
  }

  /** The password this preview is behind right now, or null when it is open (or login-only). */
  #secretFor(entry: RouteEntry): Secret | null {
    if (entry.passwordLogin === "only") return null;
    const pw: EntryPassword = entry.password ?? { mode: "inherit" };
    const raw = pw.mode === "own" ? pw : pw.mode === "inherit" ? this.#o.sharedPassword() : null;
    if (!raw) return null;
    let fp = this.#fps.get(raw.hash);
    if (!fp) {
      fp = createHash("sha256").update(raw.hash).digest("base64url").slice(0, 16);
      if (this.#fps.size > 10_000) this.#fps.clear();
      this.#fps.set(raw.hash, fp);
    }
    return { hash: raw.hash, salt: raw.salt, fp };
  }

  #passwordCookieFor(entry: RouteEntry, fp: string): string {
    const payload = `${entry.previewId}.${this.#o.now() + this.#o.passwordCookieTtlMs}.${fp}`;
    return `${payload}.${b64(this.#mac("password", payload))}`;
  }

  #hasPasswordCookie(req: Request, entry: RouteEntry, fp: string): boolean {
    const header = req.headers.get("cookie");
    if (!header) return false;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0 || part.slice(0, eq).trim() !== PASSWORD_COOKIE) continue;
      const [previewId, exp, cfp, sig, extra] = part
        .slice(eq + 1)
        .trim()
        .split(".");
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

  /** True when this preview is behind a password right now (for the UI and the log, not the gate). */
  isProtected(entry: RouteEntry): boolean {
    return this.#secretFor(entry) !== null;
  }

  /**
   * The dispatcher's hook: `check`, plus the one request that must be awaited -- the
   * password form's POST. Kept apart so `check` stays synchronous for the WebSocket path.
   */
  readonly handle = (
    entry: RouteEntry,
    req: Request,
    clientIp = "",
  ): Response | Promise<Response> | null => {
    if (
      req.method === "POST" &&
      req.url.includes(PASSWORD_PATH) &&
      new URL(req.url).pathname === PASSWORD_PATH
    ) {
      const secret = this.#secretFor(entry);
      if (!secret) return plain(404, "not found");
      return this.#submit(entry, req, clientIp, secret);
    }
    return this.check(entry, req);
  };

  async #submit(
    entry: RouteEntry,
    req: Request,
    clientIp: string,
    secret: Secret,
  ): Promise<Response> {
    // A cross-site form must not sign a visitor in (or burn their guesses).
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== "null") {
      let host = "";
      try {
        host = new URL(origin).hostname;
      } catch {
        /* unparseable: refused below */
      }
      if (host !== entry.hostname)
        return plain(403, "This form must be sent from the preview's own page.");
    }
    if (!this.#o.passwords)
      return plain(503, "Password-protected previews are not available on this server.");
    const form = await readForm(req);
    if (!form) return plain(413, "That request is too large to be the password form.");
    const to = safePath(form.get("to"));
    const given = form.get("password") ?? "";

    const source = sourceKey(clientIp || "unknown");
    const verdict = this.#o.limiter?.check(source, entry.previewId) ?? { ok: true };
    if (!verdict.ok) {
      this.#o.onPasswordFailure?.(entry, clientIp, "throttled");
      return passwordPage(
        entry.hostname,
        to,
        `Too many attempts. Try again in ${Math.ceil(verdict.retryAfterSec / 60)} minute(s).`,
        429,
        verdict.retryAfterSec,
      );
    }
    let ok: boolean;
    try {
      ok = given !== "" && given.length <= 1024 && (await this.#o.passwords.verify(given, secret));
    } catch {
      return passwordPage(entry.hostname, to, "The server is busy. Try again in a moment.", 503, 2);
    }
    if (!ok) {
      this.#o.limiter?.fail(source, entry.previewId);
      this.#o.onPasswordFailure?.(entry, clientIp, "wrong");
      return passwordPage(entry.hostname, to, "That password is not right.", 401);
    }
    this.#o.limiter?.succeed(entry.previewId);
    return new Response(null, {
      status: 303,
      headers: {
        location: to,
        "set-cookie": `${PASSWORD_COOKIE}=${this.#passwordCookieFor(entry, secret.fp)}; Max-Age=${Math.floor(this.#o.passwordCookieTtlMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        "cache-control": "no-store",
      },
    });
  }

  /**
   * The dispatcher's hook (and the WebSocket path's). null means "let it through".
   * `/__gangway/*` is answered here for EVERY preview, so the prefix can never reach an
   * upstream and a preview cannot serve a convincing fake of it.
   */
  readonly check = (entry: RouteEntry, req: Request): Response | null => {
    // The hot path: a public preview with no password, an ordinary path. No URL parse, no HMAC.
    const secret = this.#secretFor(entry);
    const priv = isPrivate(entry);
    if (!priv && secret === null && !req.url.includes("/__gangway")) return null;
    const url = new URL(req.url);

    const gate =
      priv || secret !== null ? this.#gateCookie(req, entry) : { valid: false, skip: false };
    const loginSkips = secret !== null && this.#loginSkips(entry);

    if (url.pathname.startsWith(GATE_PREFIX) || url.pathname === GATE_PREFIX.slice(0, -1)) {
      // app sent a visitor back who cannot skip the password: the form, and no bounce.
      if (url.pathname === PASSWORD_PATH && req.method === "GET" && secret !== null) {
        if (this.#hasPasswordCookie(req, entry, secret.fp))
          return redirect(safePath(url.searchParams.get("to")));
        return passwordPage(entry.hostname, safePath(url.searchParams.get("to")), null, 401);
      }
      // The form's POST goes through `handle`; anything else at this path is a 404 like the rest.
      if ((!priv && !loginSkips) || url.pathname !== AUTH_PATH || req.method !== "GET")
        return plain(404, "not found");
      const ticket = this.#redeem(url.searchParams.get("ticket") ?? "", entry);
      if (!ticket) {
        return plain(
          403,
          "This sign-in link has expired or was already used. Open the preview again to get a new one.",
        );
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: safePath(url.searchParams.get("to")),
          "set-cookie": `${GATE_COOKIE}=${this.#cookieFor(entry, ticket.s === 1)}; Max-Age=${Math.floor(this.#o.cookieTtlMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
          // The ticket is in this URL. Do not let the next page's requests carry it onward.
          "referrer-policy": "no-referrer",
        },
      });
    }

    // Only a top-level page load can usefully be sent to log in. A fetch, an <img>, a
    // WebSocket or a POST cannot follow a cross-origin redirect to an HTML login page and
    // come back -- tell those plainly instead.
    const mode = req.headers.get("sec-fetch-mode");
    const navigation =
      (req.method === "GET" || req.method === "HEAD") &&
      !req.headers.has("upgrade") &&
      (mode === null || mode === "navigate");
    const back = safePath(`${url.pathname}${url.search}`);

    if (!priv || gate.valid) {
      // Signed in (or not private): the password, if there is one, comes next.
      if (secret === null || this.#hasPasswordCookie(req, entry, secret.fp)) return null;
      if (loginSkips && gate.skip) return null;
      if (!navigation)
        return plain(
          401,
          "This preview is password-protected. Open it in a browser tab and enter the password first.",
        );
      // Not signed in here yet, and a login would do: ask app once. It sends a stranger
      // straight back to the form.
      if (loginSkips && !gate.valid) return redirect(this.#appGate(entry, back));
      return passwordPage(entry.hostname, back, null, 401);
    }

    if (!navigation)
      return plain(401, "This preview is private. Open it in a browser tab and log in first.");
    return redirect(this.#appGate(entry, back));
  };

  #appGate(entry: RouteEntry, to: string): string {
    const target = new URL("/v1/auth/gate", this.#o.appOrigin());
    target.searchParams.set("host", entry.hostname);
    target.searchParams.set("to", to);
    return target.toString();
  }
}

/** Private visibility, or login-only access (ADR-0023): a gangway login is the only way in. */
function isPrivate(entry: RouteEntry): boolean {
  return entry.visibility === "private" || entry.passwordLogin === "only";
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

/** The form body, read with a cap: a preview visitor is untrusted and this runs in the proxy. */
async function readForm(req: Request): Promise<URLSearchParams | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_FORM_BYTES) return null;
  if (!req.body) return new URLSearchParams();
  const reader = (req.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The password form. Served by gangway on the preview's own hostname, before anything of the
 * preview's runs: no scripts, no external resources, nothing the preview can style or read.
 */
function passwordPage(
  host: string,
  to: string,
  error: string | null,
  status: number,
  retryAfterSec?: number,
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Password required</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#171717;--muted:#737373;--card:#fff;--line:#e5e5e5;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#f5f5f5;--muted:#a3a3a3;--card:#171717;--line:#262626;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
form{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:17px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
input[type=password]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{margin-top:12px;width:100%;padding:9px;border:0;border-radius:8px;background:var(--fg);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--err);margin:10px 0 0;font-size:13px}
</style></head><body>
<form method="post" action="${PASSWORD_PATH}">
<h1>This preview is password-protected</h1>
<p>${escapeHtml(host)}</p>
<input type="hidden" name="to" value="${escapeHtml(to)}">
<input type="password" name="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required autofocus>
<button type="submit">Open preview</button>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
</form></body></html>
`;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
  if (retryAfterSec !== undefined) headers["retry-after"] = String(retryAfterSec);
  return new Response(html, { status, headers });
}

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * Removes gangway's own cookies from a Cookie header bound for a preview. Everything named
 * `__Host-gw_*`: the gate cookie above, and -- belt and braces, a browser would never send
 * it to this host -- the session cookie. Returns null when nothing is left.
 */
export function stripGangwayCookies(header: string | null | undefined): string | null {
  if (!header) return null;
  const kept = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith("__Host-gw_"));
  return kept.length > 0 ? kept.join("; ") : null;
}

/** The gate key lives with everything else that must survive a restart and ride in a backup. */
export function loadOrCreateGateKey(store: {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}): Buffer {
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
