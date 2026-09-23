import type { Context, Hono } from "hono";
import { ChangePasswordSchema, LoginRequestSchema, SetupRequestSchema } from "@gangway/shared/api";
import type { User } from "@gangway/shared/domain";
import type { Accounts, RequestMeta } from "../../auth/accounts.ts";
import type { Actor } from "../../auth/actor.ts";
import type { Bootstrap } from "../../auth/bootstrap.ts";
import type { RolePermissions } from "../../auth/roles.ts";
import { forbidden, notFound, unauthorized } from "../../errors.ts";
import { readJson } from "../problem.ts";
import type { AppEnv } from "../env.ts";
import {
  clearSessionCookie,
  isSameOrigin,
  resolveActor,
  setSessionCookie,
  type AuthDeps,
} from "../middleware/auth.ts";

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
  roles: RolePermissions;
  sessionMaxAgeSec: number;
};

type GateEntry = NonNullable<ReturnType<GateDeps["lookup"]>>;

const meta = (c: Context<AppEnv>): RequestMeta => ({
  ip: c.env.clientIp,
  userAgent: c.req.header("user-agent") ?? null,
});

const appOnly = (c: Context<AppEnv>) => {
  if (c.env.surface !== "app") throw notFound(`no such resource: ${new URL(c.req.url).pathname}`);
};

// Login CSRF: checked only when a browser sends Origin, so curl and scripts keep working.
const refuseForeignOrigin = (c: Context<AppEnv>, d: AuthRouteDeps) => {
  if (
    c.req.header("origin") !== undefined &&
    !(d.auth.originFor && isSameOrigin(c, d.auth.originFor))
  )
    throw forbidden("cross-origin request refused");
};

function wireUser(d: AuthRouteDeps, u: User) {
  const role = d.roles.roles().find((r) => r.id === u.roleId);
  return { id: u.id, email: u.email, role: { id: u.roleId, name: role?.name ?? u.roleId } };
}

function describe(d: AuthRouteDeps, actor: Actor) {
  const permissions = [...actor.permissions].sort();
  if (actor.kind === "token")
    return {
      authenticated: true,
      setupRequired: false,
      token: { id: actor.tokenId, scopes: actor.scopes },
      permissions,
    };
  if (actor.kind === "forge" || actor.kind === "workflow")
    return { authenticated: true, setupRequired: false, permissions };
  const user = d.accounts.getUser(actor.userId);
  return {
    authenticated: true,
    setupRequired: false,
    ...(user ? { user: wireUser(d, user) } : {}),
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
  if (!gate || !entry || !kind || (!kind.private && !kind.passwordSkippable))
    throw notFound("no such private preview");
  return { gate, entry, kind };
}

function toPreview(
  c: Context<AppEnv>,
  gate: GateDeps,
  entry: GateEntry,
  path: string,
  to: string,
  ticket: string | null,
) {
  const target = new URL(path, gate.originFor(entry.hostname));
  if (ticket !== null) target.searchParams.set("ticket", ticket);
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

    const actor = await resolveActor(c, d.auth).catch(() => null);
    const skipPassword =
      kind.passwordSkippable && actor !== null && actor.permissions.has("previews.skip_password");
    if (!kind.private) {
      if (!skipPassword) return toPreview(c, gate, entry, "/__gangway/password", to, null);
      const ticket = gate.issueTicket(entry, { skipPassword });
      return toPreview(c, gate, entry, "/__gangway/auth", to, ticket);
    }
    if (!actor) {
      const back = `/v1/auth/gate?host=${encodeURIComponent(entry.hostname)}&to=${encodeURIComponent(to)}`;
      return c.redirect(`/login?returnUrl=${encodeURIComponent(back)}`, 302);
    }
    if (!actor.permissions.has("previews.view_private"))
      throw forbidden('requires the "previews.view_private" permission');

    const ticket = gate.issueTicket(entry, { skipPassword });
    return toPreview(c, gate, entry, "/__gangway/auth", to, ticket);
  });
}

export function authRoutes(pub: Hono<AppEnv>, d: AuthRouteDeps): void {
  pub.get("/auth/session", async (c) => {
    c.header("cache-control", "no-store");
    const actor = await resolveActor(c, d.auth).catch(() => null);
    return c.json(
      actor ? describe(d, actor) : { authenticated: false, setupRequired: d.bootstrap.pending },
    );
  });

  pub.post("/auth/login", async (c) => {
    appOnly(c);
    refuseForeignOrigin(c, d);
    const { email, password } = LoginRequestSchema.parse(await readJson(c));
    const { user, secret } = await d.accounts.login(email, password, meta(c));
    setSessionCookie(c, secret, d.sessionMaxAgeSec);
    c.header("cache-control", "no-store");
    return c.json({ user: wireUser(d, user), permissions: [...d.roles.for(user.roleId)].sort() });
  });

  pub.post("/auth/setup", async (c) => {
    appOnly(c);
    if (!d.bootstrap.pending) throw notFound("no such resource: /v1/auth/setup");
    refuseForeignOrigin(c, d);
    const { token, email, password } = SetupRequestSchema.parse(await readJson(c));
    if (!d.bootstrap.check(token))
      throw forbidden("that setup link is not valid; the current one is in the server's output");
    const { user, secret } = await d.accounts.setupFirstAdmin(email, password, meta(c));
    setSessionCookie(c, secret, d.sessionMaxAgeSec);
    c.header("cache-control", "no-store");
    return c.json(
      { user: wireUser(d, user), permissions: [...d.roles.for(user.roleId)].sort() },
      201,
    );
  });

  gateRoute(pub, d);

  const required = async (c: Context<AppEnv>): Promise<Actor> => {
    const actor = await resolveActor(c, d.auth);
    if (!actor) throw unauthorized();
    return actor;
  };

  pub.post("/auth/logout", async (c) => {
    const actor = await resolveActor(c, d.auth);
    if (actor) d.accounts.logout(actor);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  pub.post("/auth/password", async (c) => {
    const actor = await required(c);
    const { current, next } = ChangePasswordSchema.parse(await readJson(c));
    await d.accounts.changeOwnPassword(actor, current, next, meta(c));
    return c.body(null, 204);
  });
}
