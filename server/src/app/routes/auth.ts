import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ChangePasswordSchema, LoginRequestSchema, SetupRequestSchema } from "@gangway/shared/api";
import {
  EmailLinkSchema,
  PasswordResetRequestSchema,
  RedeemEmailLinkSchema,
} from "@gangway/shared/mail-api";
import type { User } from "@gangway/shared/domain";
import type { Accounts, RequestMeta } from "../../auth/accounts.ts";
import type { Actor } from "../../auth/actor.ts";
import type { Bootstrap } from "../../auth/bootstrap.ts";
import { WindowLimiter } from "../../auth/limiter.ts";
import type { EmailLinks } from "../../auth/links.ts";
import type { RolePermissions } from "../../auth/roles.ts";
import type { Sso } from "../../auth/sso.ts";
import { AppError, forbidden, notFound, unauthorized } from "../../errors.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import {
  clearSessionCookie,
  isSameOrigin,
  resolveActor,
  setSessionCookie,
  type AuthDeps,
} from "../middleware/auth.ts";
import { compareCodeUnits } from "../../util/compare.ts";

export type GateDeps = {
  lookup(host: string): { hostname: string; previewId: string; visibility: string } | undefined;
  gateable?(host: string): { private: boolean; passwordSkippable: boolean };
  issueTicket(
    entry: { hostname: string; previewId: string },
    o?: { skipPassword?: boolean },
  ): string;
  originFor(host: string): string;
  safePath(raw: string | null | undefined): string;
};

export type AuthRouteDeps = {
  auth: AuthDeps;
  gate?: GateDeps | undefined;
  accounts: Accounts;
  bootstrap: Bootstrap;
  links?: EmailLinks | undefined;
  roles: RolePermissions;
  sessionMaxAgeSec: number;
  sso?: Sso | undefined;
  /** False only while an identity provider is set up and password sign-in is turned off. */
  passwords?: (() => boolean) | undefined;
  /** Caps sign-in starts per source, so a flood cannot push out other people's pending state. */
  ssoStarts?: WindowLimiter | undefined;
};

const STATE_COOKIE = "gw_oidc";

const passwordsOn = (d: AuthRouteDeps) => d.passwords?.() ?? true;

const refuseWithoutPasswords = (d: AuthRouteDeps) => {
  if (!passwordsOn(d)) {
    throw forbidden(
      `password sign-in is off on this server; use "${d.sso?.label() ?? "single sign-on"}"`,
    );
  }
};

// Only a path on this origin, so the callback cannot be made into an open redirect. Browsers drop
// tabs and newlines from URLs, so "/\t/evil.example" would become "//evil.example": refuse them.
const safeNext = (raw: string | undefined): string =>
  raw !== undefined && /^\/(?![/\\])/.test(raw) && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : "/";

type GateEntry = NonNullable<ReturnType<GateDeps["lookup"]>>;

const meta = (c: Context<AppEnv>): RequestMeta => ({
  ip: c.env.clientIp,
  userAgent: c.req.header("user-agent") ?? null,
});

const appOnly = (c: Context<AppEnv>) => {
  if (c.env.surface !== "app") {
    throw notFound(`no such resource: ${new URL(c.req.url).pathname}`);
  }
};

// Login CSRF: checked only when a browser sends Origin, so curl and scripts keep working.
const refuseForeignOrigin = (c: Context<AppEnv>, d: AuthRouteDeps) => {
  if (
    c.req.header("origin") !== undefined &&
    !(d.auth.originFor && isSameOrigin(c, d.auth.originFor))
  ) {
    throw forbidden("cross-origin request refused");
  }
};

function wireUser(d: AuthRouteDeps, u: User) {
  const role = d.roles.roles().find((r) => r.id === u.roleId);
  return { id: u.id, email: u.email, role: { id: u.roleId, name: role?.name ?? u.roleId } };
}

function describe(d: AuthRouteDeps, actor: Actor) {
  const permissions = [...actor.permissions].sort(compareCodeUnits);
  if (actor.kind === "token") {
    return {
      authenticated: true,
      setupRequired: false,
      token: { id: actor.tokenId, scopes: actor.scopes },
      passwords: passwordsOn(d),
      permissions,
    };
  }
  if (actor.kind === "forge" || actor.kind === "workflow") {
    return { authenticated: true, setupRequired: false, passwords: passwordsOn(d), permissions };
  }
  const user = d.accounts.getUser(actor.userId);
  return {
    authenticated: true,
    setupRequired: false,
    ...(user ? { user: wireUser(d, user) } : {}),
    passwords: passwordsOn(d),
    permissions,
  };
}

function gateTarget(gate: GateDeps | undefined, host: string) {
  const entry = gate?.lookup(host);
  const kind = entry
    ? (gate?.gateable?.(host) ?? {
        private: entry.visibility === "private",
        passwordSkippable: false,
      })
    : undefined;
  if (!gate || !entry || !kind || (!kind.private && !kind.passwordSkippable)) {
    throw notFound("no such private preview");
  }
  return { gate, entry, kind };
}

type PreviewTarget = { gate: GateDeps; entry: GateEntry; to: string };

function toPreview(
  c: Context<AppEnv>,
  { gate, entry, to }: PreviewTarget,
  path: string,
  ticket: string | null,
) {
  const target = new URL(path, gate.originFor(entry.hostname));
  if (ticket !== null) {
    target.searchParams.set("ticket", ticket);
  }
  target.searchParams.set("to", to);
  c.header("referrer-policy", "no-referrer");
  return c.redirect(target.toString(), 302);
}

// Only a live gateable preview host is accepted, or this GET would be an open redirect.
function gateRoute(pub: Hono<AppEnv>, d: AuthRouteDeps): void {
  pub.get("/auth/gate", async (c) => {
    appOnly(c);
    const { gate, entry, kind } = gateTarget(d.gate, (c.req.query("host") ?? "").toLowerCase());
    const to = gate.safePath(c.req.query("to"));
    c.header("cache-control", "no-store");
    const dest = { gate, entry, to };

    const actor = await resolveActor(c, d.auth).catch(() => null);
    const skipPassword =
      kind.passwordSkippable && actor?.permissions.has("previews.skip_password") === true;
    if (!kind.private) {
      if (!skipPassword) {
        return toPreview(c, dest, "/__gangway/password", null);
      }
      const ticket = gate.issueTicket(entry, { skipPassword });
      return toPreview(c, dest, "/__gangway/auth", ticket);
    }
    if (!actor) {
      const back = `/v1/auth/gate?host=${encodeURIComponent(entry.hostname)}&to=${encodeURIComponent(to)}`;
      return c.redirect(`/login?returnUrl=${encodeURIComponent(back)}`, 302);
    }
    if (!actor.permissions.has("previews.view_private")) {
      throw forbidden('requires the "previews.view_private" permission');
    }

    const ticket = gate.issueTicket(entry, { skipPassword });
    return toPreview(c, dest, "/__gangway/auth", ticket);
  });
}

// Forgot password, and the page an emailed link opens. The link's secret travels in the body,
// never a URL gangway logs.
function emailLinkRoutes(pub: Hono<AppEnv>, d: AuthRouteDeps): void {
  const links = () => {
    if (!d.links) {
      throw notFound("no such resource");
    }
    return d.links;
  };

  pub.post("/auth/password-reset", async (c) => {
    appOnly(c);
    refuseForeignOrigin(c, d);
    refuseWithoutPasswords(d);
    const { email } = PasswordResetRequestSchema.parse(await readJson(c));
    links().requestReset(email, meta(c));
    return c.body(null, 202);
  });

  pub.post("/auth/link", async (c) => {
    appOnly(c);
    refuseForeignOrigin(c, d);
    refuseWithoutPasswords(d);
    const { token } = EmailLinkSchema.parse(await readJson(c));
    c.header("cache-control", "no-store");
    return c.json(links().inspect(token));
  });

  pub.post("/auth/link/redeem", async (c) => {
    appOnly(c);
    refuseForeignOrigin(c, d);
    refuseWithoutPasswords(d);
    const { token, password } = RedeemEmailLinkSchema.parse(await readJson(c));
    const { user, secret } = await links().redeem(token, password, meta(c));
    setSessionCookie(c, secret, d.sessionMaxAgeSec);
    c.header("cache-control", "no-store");
    return c.json({
      user: wireUser(d, user),
      permissions: [...d.roles.for(user.roleId)].sort(compareCodeUnits),
    });
  });
}

export function authRoutes(pub: Hono<AppEnv>, d: AuthRouteDeps): void {
  pub.get("/auth/session", async (c) => {
    c.header("cache-control", "no-store");
    const actor = await resolveActor(c, d.auth).catch(() => null);
    return c.json(
      actor
        ? describe(d, actor)
        : {
            authenticated: false,
            setupRequired: d.bootstrap.pending,
            passwordReset: passwordsOn(d) && d.links?.available === true,
            oidc: d.sso?.configured ? { label: d.sso.label() } : null,
            passwords: passwordsOn(d),
          },
    );
  });

  pub.post("/auth/login", async (c) => {
    appOnly(c);
    refuseForeignOrigin(c, d);
    refuseWithoutPasswords(d);
    const { email, password } = LoginRequestSchema.parse(await readJson(c));
    const { user, secret } = await d.accounts.login(email, password, meta(c));
    setSessionCookie(c, secret, d.sessionMaxAgeSec);
    c.header("cache-control", "no-store");
    return c.json({
      user: wireUser(d, user),
      permissions: [...d.roles.for(user.roleId)].sort(compareCodeUnits),
    });
  });

  pub.post("/auth/setup", async (c) => {
    appOnly(c);
    if (!d.bootstrap.pending) {
      throw notFound("no such resource: /v1/auth/setup");
    }
    refuseForeignOrigin(c, d);
    const { token, email, password } = SetupRequestSchema.parse(await readJson(c));
    if (!d.bootstrap.check(token)) {
      throw forbidden("that setup link is not valid; the current one is in the server's output");
    }
    const { user, secret } = await d.accounts.setupFirstAdmin(email, password, meta(c));
    setSessionCookie(c, secret, d.sessionMaxAgeSec);
    c.header("cache-control", "no-store");
    return c.json(
      {
        user: wireUser(d, user),
        permissions: [...d.roles.for(user.roleId)].sort(compareCodeUnits),
      },
      201,
    );
  });

  gateRoute(pub, d);
  emailLinkRoutes(pub, d);
  ssoRoutes(pub, d);

  const required = async (c: Context<AppEnv>): Promise<Actor> => {
    const actor = await resolveActor(c, d.auth);
    if (!actor) {
      throw unauthorized();
    }
    return actor;
  };

  pub.post("/auth/logout", async (c) => {
    const actor = await resolveActor(c, d.auth);
    if (actor) {
      d.accounts.logout(actor);
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  pub.post("/auth/password", async (c) => {
    const actor = await required(c);
    refuseWithoutPasswords(d);
    const { current, next } = ChangePasswordSchema.parse(await readJson(c));
    await d.accounts.changeOwnPassword(actor, current, next, meta(c));
    return c.body(null, 204);
  });
}

// Sign-in through the identity provider. The callback is a top-level GET from the provider, so
// the state cookie is SameSite=Lax; the state is also held server-side and used once.
function ssoRoutes(pub: Hono<AppEnv>, d: AuthRouteDeps): void {
  const starts = d.ssoStarts ?? new WindowLimiter({ max: 20, windowMs: 60_000 });
  const sso = () => {
    if (!d.sso?.configured) {
      throw notFound("sign-in with an identity provider is not set up");
    }
    return d.sso;
  };
  const back = (c: Context<AppEnv>, reason: string) => {
    deleteCookie(c, STATE_COOKIE, { prefix: "host", path: "/", secure: true });
    c.header("cache-control", "no-store");
    return c.redirect(`/login?sso=${reason}`, 302);
  };

  pub.get("/auth/oidc/start", async (c) => {
    appOnly(c);
    if (!starts.allow(meta(c).ip)) {
      return back(c, "rate-limited");
    }
    const { url, state } = await sso().begin(safeNext(c.req.query("next")));
    setCookie(c, STATE_COOKIE, state, {
      prefix: "host",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 600,
    });
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.redirect(url, 302);
  });

  pub.get("/auth/oidc/callback", async (c) => {
    appOnly(c);
    const provider = sso();
    const m = meta(c);
    // The person cancelled, or the provider refused them: nothing to count against anyone.
    if (c.req.query("error") !== undefined) {
      return back(c, "cancelled");
    }
    try {
      d.accounts.ssoGate(m);
    } catch {
      return back(c, "rate-limited");
    }
    let identity;
    try {
      identity = await provider.complete({
        state: c.req.query("state") ?? "",
        cookieState: getCookie(c, STATE_COOKIE, "host"),
        code: c.req.query("code") ?? "",
      });
    } catch (e) {
      const reason = e instanceof AppError && e.status === 401 ? "failed" : "unavailable";
      d.accounts.ssoFailed(m, e instanceof Error ? e.message : String(e));
      return back(c, reason);
    }
    let secret: string;
    try {
      ({ secret } = await d.accounts.ssoLogin(identity, m));
    } catch (e) {
      if (e instanceof AppError && e.status === 429) {
        return back(c, "rate-limited");
      }
      if (e instanceof AppError && e.status === 403) {
        return back(c, "no-account");
      }
      throw e;
    }
    deleteCookie(c, STATE_COOKIE, { prefix: "host", path: "/", secure: true });
    setSessionCookie(c, secret, d.sessionMaxAgeSec);
    c.header("cache-control", "no-store");
    return c.redirect(identity.next, 302);
  });
}
