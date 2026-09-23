import { randomBytes } from "node:crypto";
import { sourceKey, type LoginLimiter } from "../auth/limiter.ts";
import type { Passwords } from "../auth/password.ts";
import type { EntryPassword, RouteEntry } from "../routing/table.ts";
import { sha256 } from "../util/hash.ts";
import { PASSWORD_PATH, passwordPage, plain, readForm, redirect } from "./gate-pages.ts";
import { GateTokens, type GateCookie } from "./gate-tokens.ts";

export { GATE_COOKIE, PASSWORD_COOKIE } from "./gate-tokens.ts";
const GATE_PREFIX = "/__gangway/";
const AUTH_PATH = "/__gangway/auth";

export type GateOptions = {
  key: Buffer;
  appOrigin: () => string;
  now?: () => number;
  ticketTtlMs?: number;
  cookieTtlMs?: number;
  passwordCookieTtlMs?: number;
  sharedPassword?: () => { hash: string; salt: string } | null;
  passwords?: Pick<Passwords, "verify">;
  limiter?: Pick<LoginLimiter, "check" | "fail" | "succeed">;
  onPasswordFailure?: (entry: RouteEntry, clientIp: string, reason: "wrong" | "throttled") => void;
  loginDefault?: () => boolean;
};

type ResolvedOptions = Required<Omit<GateOptions, "passwords" | "limiter" | "onPasswordFailure">> &
  Pick<GateOptions, "passwords" | "limiter" | "onPasswordFailure">;
type Secret = { hash: string; salt: string; fp: string };
type Visit = {
  entry: RouteEntry;
  req: Request;
  url: URL;
  secret: Secret | null;
  priv: boolean;
  gate: GateCookie;
  loginSkips: boolean;
};

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

function isNavigation(req: Request): boolean {
  const mode = req.headers.get("sec-fetch-mode");
  return (
    (req.method === "GET" || req.method === "HEAD") &&
    !req.headers.has("upgrade") &&
    (mode === null || mode === "navigate")
  );
}

function foreignOrigin(req: Request, hostname: string): boolean {
  const origin = req.headers.get("origin");
  if (origin === null || origin === "null") return false;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {}
  return host !== hostname;
}

export class PreviewGate {
  readonly #o: ResolvedOptions;
  readonly #tokens: GateTokens;
  readonly #fps = new Map<string, string>();

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
    this.#tokens = new GateTokens(this.#o);
  }

  issueTicket(
    entry: Pick<RouteEntry, "hostname" | "previewId">,
    o: { skipPassword?: boolean } = {},
  ): string {
    return this.#tokens.issueTicket(entry, o);
  }

  #loginSkips(entry: RouteEntry): boolean {
    const login = entry.passwordLogin ?? "inherit";
    return login === "on" || (login === "inherit" && this.#o.loginDefault());
  }

  gateable(entry: RouteEntry): { private: boolean; passwordSkippable: boolean } {
    return {
      private: isPrivate(entry),
      passwordSkippable: this.#secretFor(entry) !== null && this.#loginSkips(entry),
    };
  }

  #secretFor(entry: RouteEntry): Secret | null {
    if (entry.passwordLogin === "only") return null;
    const pw: EntryPassword = entry.password ?? { mode: "inherit" };
    const raw = pw.mode === "own" ? pw : pw.mode === "inherit" ? this.#o.sharedPassword() : null;
    if (!raw) return null;
    let fp = this.#fps.get(raw.hash);
    if (!fp) {
      fp = sha256(raw.hash, "base64url").slice(0, 16);
      if (this.#fps.size > 10_000) this.#fps.clear();
      this.#fps.set(raw.hash, fp);
    }
    return { hash: raw.hash, salt: raw.salt, fp };
  }

  isProtected(entry: RouteEntry): boolean {
    return this.#secretFor(entry) !== null;
  }

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
    if (foreignOrigin(req, entry.hostname))
      return plain(403, "This form must be sent from the preview's own page.");
    if (!this.#o.passwords)
      return plain(503, "Password-protected previews are not available on this server.");
    const form = await readForm(req);
    if (!form) return plain(413, "That request is too large to be the password form.");
    const to = safePath(form.get("to"));
    const given = form.get("password") ?? "";

    const source = sourceKey(clientIp || "unknown");
    const throttled = this.#throttled(entry, clientIp, source, to);
    if (throttled) return throttled;
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
        "set-cookie": this.#tokens.passwordSetCookie(entry, secret.fp),
        "cache-control": "no-store",
      },
    });
  }

  #throttled(entry: RouteEntry, clientIp: string, source: string, to: string): Response | null {
    const verdict = this.#o.limiter?.check(source, entry.previewId) ?? { ok: true };
    if (verdict.ok) return null;
    this.#o.onPasswordFailure?.(entry, clientIp, "throttled");
    return passwordPage(
      entry.hostname,
      to,
      `Too many attempts. Try again in ${Math.ceil(verdict.retryAfterSec / 60)} minute(s).`,
      429,
      verdict.retryAfterSec,
    );
  }

  // /__gangway/* is answered here for every preview so it never reaches an upstream.
  readonly check = (entry: RouteEntry, req: Request): Response | null => {
    const secret = this.#secretFor(entry);
    const priv = isPrivate(entry);
    if (!priv && secret === null && !req.url.includes("/__gangway")) return null;
    const url = new URL(req.url);

    const gate =
      priv || secret !== null ? this.#tokens.gateCookie(req, entry) : { valid: false, skip: false };
    const loginSkips = secret !== null && this.#loginSkips(entry);
    const visit: Visit = { entry, req, url, secret, priv, gate, loginSkips };

    if (url.pathname.startsWith(GATE_PREFIX) || url.pathname === GATE_PREFIX.slice(0, -1))
      return this.#gatePath(visit);

    // Only a top-level navigation can follow a cross-origin redirect to the login page and come back.
    const navigation = isNavigation(req);
    const back = safePath(`${url.pathname}${url.search}`);

    if (!priv || gate.valid) return this.#passwordStep(visit, navigation, back);

    if (!navigation)
      return plain(401, "This preview is private. Open it in a browser tab and log in first.");
    return redirect(this.#appGate(entry, back));
  };

  #gatePath({ entry, req, url, secret, priv, loginSkips }: Visit): Response {
    if (url.pathname === PASSWORD_PATH && req.method === "GET" && secret !== null) {
      if (this.#tokens.hasPasswordCookie(req, entry, secret.fp))
        return redirect(safePath(url.searchParams.get("to")));
      return passwordPage(entry.hostname, safePath(url.searchParams.get("to")), null, 401);
    }
    if ((!priv && !loginSkips) || url.pathname !== AUTH_PATH || req.method !== "GET")
      return plain(404, "not found");
    const ticket = this.#tokens.redeem(url.searchParams.get("ticket") ?? "", entry);
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
        "set-cookie": this.#tokens.gateSetCookie(entry, ticket.s === 1),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  #passwordStep(
    { entry, req, secret, gate, loginSkips }: Visit,
    navigation: boolean,
    back: string,
  ): Response | null {
    if (secret === null || this.#tokens.hasPasswordCookie(req, entry, secret.fp)) return null;
    if (loginSkips && gate.skip) return null;
    if (!navigation)
      return plain(
        401,
        "This preview is password-protected. Open it in a browser tab and enter the password first.",
      );
    if (loginSkips && !gate.valid) return redirect(this.#appGate(entry, back));
    return passwordPage(entry.hostname, back, null, 401);
  }

  #appGate(entry: RouteEntry, to: string): string {
    const target = new URL("/v1/auth/gate", this.#o.appOrigin());
    target.searchParams.set("host", entry.hostname);
    target.searchParams.set("to", to);
    return target.toString();
  }
}

function isPrivate(entry: RouteEntry): boolean {
  return entry.visibility === "private" || entry.passwordLogin === "only";
}

export function stripGangwayCookies(header: string | null | undefined): string | null {
  if (!header) return null;
  const kept = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith("__Host-gw_"));
  return kept.length > 0 ? kept.join("; ") : null;
}

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
