/**
 * §8.1 `/v1/auth/*`. A THIN adapter (ADR-0003) over auth/accounts.ts.
 *
 * All of these live in the PUBLIC mount: login and setup have no credential yet, "who am
 * I" must answer an anonymous caller, and logout and change-password are for any
 * logged-in person whatever their role -- there is no permission to name. So each handler
 * here answers for its own access, and the rule that every route behind `authenticate`
 * names a permission stays without an exception.
 */
import type { Context, Hono } from "hono";
import { ChangePasswordSchema, LoginRequestSchema, SetupRequestSchema } from "../../../../shared/src/api.ts";
import type { User } from "../../../../shared/src/domain.ts";
import type { Accounts, RequestMeta } from "../../auth/accounts.ts";
import type { Actor } from "../../auth/actor.ts";
import type { Bootstrap } from "../../auth/bootstrap.ts";
import type { RolePermissions } from "../../auth/roles.ts";
import { badRequest, forbidden, notFound, unauthorized } from "../../errors.ts";
import type { AppEnv } from "../env.ts";
import { clearSessionCookie, isSameOrigin, resolveActor, setSessionCookie, type AuthDeps } from "../middleware/auth.ts";

/** What `/v1/auth/gate` needs from the proxy side, without importing it. */
export type GateDeps = {
  /** The live route for a preview hostname, if there is one. */
  lookup(host: string): { hostname: string; previewId: string; visibility: string } | undefined;
  issueTicket(entry: { hostname: string; previewId: string }): string;
  /** `https://<preview host>[:port]` */
  originFor(host: string): string;
  safePath(raw: string | null | undefined): string;
};

export type AuthRouteDeps = {
  auth: AuthDeps;
  /** Absent: private previews cannot be opened (and deploy says so). */
  gate?: GateDeps | undefined;
  accounts: Accounts;
  bootstrap: Bootstrap;
  roles: RolePermissions;
  /** The cookie's Max-Age: the session's absolute cap. */
  sessionMaxAgeSec: number;
};

export function authRoutes(pub: Hono<AppEnv>, d: AuthRouteDeps): void {
  const meta = (c: Context<AppEnv>): RequestMeta => ({ ip: c.env.clientIp, userAgent: c.req.header("user-agent") ?? null });
  const json = async (c: Context<AppEnv>) => c.req.json().catch(() => { throw badRequest("the request body is not JSON"); });

  /** Sessions belong to the `app` hostname, where the cookie is host-only. Elsewhere these do not exist. */
  const appOnly = (c: Context<AppEnv>) => { if (c.env.surface !== "app") throw notFound(`no such resource: ${new URL(c.req.url).pathname}`); };

  /**
   * Login CSRF: a hostile page logging YOUR browser into THEIR account, so that what you do
   * next lands in it. There is no session to protect yet, so the check is on Origin alone,
   * and only when a browser sent one -- curl sends none, and scripts must keep working.
   */
  const refuseForeignOrigin = (c: Context<AppEnv>) => {
    if (c.req.header("origin") !== undefined && !(d.auth.originFor && isSameOrigin(c, d.auth.originFor))) throw forbidden("cross-origin request refused");
  };

  const wireUser = (u: User) => {
    const role = d.roles.roles().find((r) => r.id === u.roleId);
    return { id: u.id, email: u.email, role: { id: u.roleId, name: role?.name ?? u.roleId } };
  };

  const describe = (actor: Actor) => {
    const permissions = [...actor.permissions].sort();
    if (actor.kind === "token") return { authenticated: true, setupRequired: false, token: { id: actor.tokenId, scopes: actor.scopes }, permissions };
    // A forge actor never holds a session or a bearer; only here for the type's sake.
    if (actor.kind === "forge") return { authenticated: true, setupRequired: false, permissions };
    const user = d.accounts.getUser(actor.userId);
    return { authenticated: true, setupRequired: false, ...(user ? { user: wireUser(user) } : {}), permissions };
  };

  /**
   * Always 200. The UI asks this first, on every load, to choose between the app, the
   * login page and first-run setup; a 401 here would be an error it has to special-case.
   * `permissions` is what the UI gates on -- it never branches on a role name.
   */
  pub.get("/auth/session", async (c) => {
    c.header("cache-control", "no-store");
    const actor = await resolveActor(c, d.auth).catch(() => null);
    return c.json(actor ? describe(actor) : { authenticated: false, setupRequired: d.bootstrap.pending });
  });

  pub.post("/auth/login", async (c) => {
    appOnly(c);
    refuseForeignOrigin(c);
    const { email, password } = LoginRequestSchema.parse(await json(c));
    const { user, secret } = await d.accounts.login(email, password, meta(c));
    setSessionCookie(c, secret, d.sessionMaxAgeSec);
    c.header("cache-control", "no-store");
    return c.json({ user: wireUser(user), permissions: [...d.roles.for(user.roleId)].sort() });
  });

  /** 404 -- not 403, not 409 -- whenever setup is not pending: a finished setup was never there. */
  pub.post("/auth/setup", async (c) => {
    appOnly(c);
    if (!d.bootstrap.pending) throw notFound("no such resource: /v1/auth/setup");
    refuseForeignOrigin(c);
    const { token, email, password } = SetupRequestSchema.parse(await json(c));
    if (!d.bootstrap.check(token)) throw forbidden("that setup link is not valid; the current one is in the server's output");
    const { user, secret } = await d.accounts.setupFirstAdmin(email, password, meta(c));
    setSessionCookie(c, secret, d.sessionMaxAgeSec);
    c.header("cache-control", "no-store");
    return c.json({ user: wireUser(user), permissions: [...d.roles.for(user.roleId)].sort() }, 201);
  });

  /**
   * §8.3, step 2 of the private-preview handshake (net/gate.ts has the whole picture). A
   * preview host sent the browser here because it had no gate cookie. This is the only
   * place the SESSION is consulted: the preview never sees it.
   *
   * A GET that redirects, so it must not be steerable. `host` has to be a LIVE, PRIVATE
   * preview -- not any hostname, which would make this an open redirect with a gangway
   * URL on the front -- and `to` is reduced to a same-origin path.
   */
  pub.get("/auth/gate", async (c) => {
    appOnly(c);
    const gate = d.gate;
    const entry = gate?.lookup((c.req.query("host") ?? "").toLowerCase());
    if (!gate || !entry || entry.visibility !== "private") throw notFound("no such private preview");
    const to = gate.safePath(c.req.query("to"));
    c.header("cache-control", "no-store");

    const actor = await resolveActor(c, d.auth).catch(() => null);
    if (!actor) {
      // Come back HERE after login, with the same two parameters and nothing else.
      const back = `/v1/auth/gate?host=${encodeURIComponent(entry.hostname)}&to=${encodeURIComponent(to)}`;
      return c.redirect(`/login?returnUrl=${encodeURIComponent(back)}`, 302);
    }
    if (!actor.permissions.has("previews.view_private")) throw forbidden('requires the "previews.view_private" permission');

    const target = new URL("/__gangway/auth", gate.originFor(entry.hostname));
    target.searchParams.set("ticket", gate.issueTicket(entry));
    target.searchParams.set("to", to);
    c.header("referrer-policy", "no-referrer");
    return c.redirect(target.toString(), 302);
  });

  const required = async (c: Context<AppEnv>): Promise<Actor> => {
    const actor = await resolveActor(c, d.auth);
    if (!actor) throw unauthorized();
    return actor;
  };

  /** Idempotent, and the cookie is cleared even if the session was already gone. */
  pub.post("/auth/logout", async (c) => {
    const actor = await resolveActor(c, d.auth);
    if (actor) d.accounts.logout(actor);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  pub.post("/auth/password", async (c) => {
    const actor = await required(c);
    const { current, next } = ChangePasswordSchema.parse(await json(c));
    await d.accounts.changeOwnPassword(actor, current, next, meta(c));
    return c.body(null, 204);
  });
}
