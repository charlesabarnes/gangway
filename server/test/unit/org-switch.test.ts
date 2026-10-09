import { describe, expect, test } from "bun:test";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { OrgSwitch } from "../../src/auth/org-switch.ts";
import { HOME_ORG_ID, OrgsRepo } from "../../src/db/repos/orgs.ts";
import { TemplatesRepo } from "../../src/db/repos/templates.ts";
import { insertOrg } from "../../src/tenancy/orgs.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { silentLogger } from "../helpers/logger.ts";

const TOKEN = "gw_org_switch_test_admin_token_0123";
const HOST = "app.preview.localhost:8443";
const ORIGIN = `https://${HOST}`;

async function make() {
  const s = setupAccounts();
  const bootstrap = new Bootstrap(() => s.users.count());
  const auth = {
    verifyToken: staticTokenVerifier(TOKEN, HOME_ORG_ID),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  const app = createApp({
    ...auth,
    logger: silentLogger(),
    v1: () => {},
    publicV1: (pub) =>
      authRoutes(pub, {
        auth,
        accounts: s.accounts,
        bootstrap,
        orgs: new OrgSwitch({ users: s.users, sessions: s.sessions, audit: s.audit }),
        roles: s.roles,
        sessionMaxAgeSec: 2_592_000,
      }),
  });
  const h = surfaceHandler(app, "app");
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", HOST);
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
    }
    return Promise.resolve(
      h(
        new Request(`${ORIGIN}${path}`, {
          ...init,
          headers,
          ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        }),
        { clientIp: "203.0.113.7" },
      ),
    );
  };
  const orgs = new OrgsRepo(s.db, s.now);
  const templates = new TemplatesRepo(s.db, s.now);
  const newOrg = (slug: string) =>
    s.db.transaction(() =>
      insertOrg({ orgs, roles: s.rolesRepo, templates }, { slug, name: slug }, s.now()),
    );
  const { user } = await s.admin();
  const acme = newOrg("acme");
  const other = newOrg("other");
  s.roles.reload();
  // Ada is a viewer in acme and nothing in other.
  s.db.run(
    "INSERT INTO memberships (org_id, user_id, role_id, created_at) VALUES ($o, $u, $r, $t)",
    { o: acme.org.id, u: user.id, r: acme.roles["viewer"]!, t: s.now() },
  );
  const login = await call("/v1/auth/login", {
    method: "POST",
    json: { email: "ada@example.com", password: PASSWORD },
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const as = (c: string) => ({
    headers: { cookie: c, origin: ORIGIN, "sec-fetch-site": "same-origin" },
  });
  return { s, call, as, cookie, acme: acme.org, other: other.org };
}

const secretOf = (cookie: string) => decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));

describe("a person's orgs", () => {
  test("lists home first, with the role in each and the current one marked", async () => {
    const t = await make();
    const res = await t.call("/v1/me/orgs", t.as(t.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { orgs } = (await res.json()) as {
      orgs: { id: string; home: boolean; current: boolean; role: { name: string } }[];
    };
    expect(orgs.map((o) => [o.id, o.home, o.current, o.role.name])).toEqual([
      [HOME_ORG_ID, true, true, "admin"],
      [t.acme.id, false, false, "viewer"],
    ]);
  });

  test("needs a session", async () => {
    const t = await make();
    expect((await t.call("/v1/me/orgs")).status).toBe(401);
    const bearer = { headers: { authorization: `Bearer ${TOKEN}` } };
    expect((await t.call("/v1/me/orgs", bearer)).status).toBe(403);
  });
});

describe("switching org", () => {
  test("rotates the session into the new org with that org's role", async () => {
    const t = await make();
    const res = await t.call("/v1/session/org", {
      ...t.as(t.cookie),
      method: "PUT",
      json: { orgId: t.acme.id },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { org: { id: string; current: boolean } }).org).toMatchObject({
      id: t.acme.id,
      current: true,
    });
    const fresh = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(fresh).not.toBe(t.cookie);
    // The old secret is gone; the new one acts in acme as a viewer.
    expect(t.s.sessions.resolve(secretOf(t.cookie))).toBeNull();
    const now = t.s.sessions.resolve(secretOf(fresh))!.actor;
    expect(now.orgId).toBe(t.acme.id);
    expect(now.permissions.has("users.manage")).toBe(false);
    const listed = (await (await t.call("/v1/me/orgs", t.as(fresh))).json()) as {
      orgs: { id: string; current: boolean }[];
    };
    expect(listed.orgs.find((o) => o.current)?.id).toBe(t.acme.id);
    expect(t.s.actions()).toContain("auth.org.switched");
  });

  test("keeps the first start, so switching never outlives the absolute lifetime", async () => {
    const t = await make();
    const before = t.s.sessions.resolve(secretOf(t.cookie))!.session.createdAt.getTime();
    t.s.clock.t += 60_000;
    const res = await t.call("/v1/session/org", {
      ...t.as(t.cookie),
      method: "PUT",
      json: { orgId: t.acme.id },
    });
    const fresh = res.headers.get("set-cookie")!.split(";")[0]!;
    const after = t.s.sessions.resolve(secretOf(fresh))!.session;
    expect(after.createdAt.getTime()).toBe(before);
    expect(after.expiresAt.getTime()).toBeLessThanOrEqual(before + t.s.sessions.timings.absoluteMs);
  });

  test("an org the person is not in is the same 404 as no org; the session stays", async () => {
    const t = await make();
    for (const orgId of [t.other.id, "01NOSUCHORG000000000000000"]) {
      const res = await t.call("/v1/session/org", {
        ...t.as(t.cookie),
        method: "PUT",
        json: { orgId },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(t.s.sessions.resolve(secretOf(t.cookie))!.actor.orgId).toBe(HOME_ORG_ID);
  });

  test("a token keeps its org, and a cross-origin page cannot move a session", async () => {
    const t = await make();
    const bearer = await t.call("/v1/session/org", {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
      json: { orgId: t.acme.id },
    });
    expect(bearer.status).toBe(403);
    const foreign = await t.call("/v1/session/org", {
      method: "PUT",
      headers: { cookie: t.cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      json: { orgId: t.acme.id },
    });
    expect(foreign.status).toBe(403);
    expect(t.s.sessions.resolve(secretOf(t.cookie))!.actor.orgId).toBe(HOME_ORG_ID);
  });

  test("a malformed body is a 422 and moves nothing", async () => {
    const t = await make();
    const res = await t.call("/v1/session/org", {
      ...t.as(t.cookie),
      method: "PUT",
      json: { org: t.acme.id },
    });
    expect(res.status).toBe(422);
    expect(t.s.sessions.resolve(secretOf(t.cookie))!.actor.orgId).toBe(HOME_ORG_ID);
  });
});
