import { describe, expect, test } from "bun:test";
import { ADMIN_ROLE_ID } from "@gangway/shared/permissions";
import { HOME_ORG_ID, OrgsRepo } from "../../src/db/repos/orgs.ts";
import { slugFor } from "../../src/tenancy/signup.ts";
import { ISSUER, make, withBo } from "../helpers/sso.ts";

const FREE = { containers: false, maxSites: 3, storageBytes: 250_000_000 };
const signupOn = { signup: { issuer: ISSUER, limits: FREE } };

function stranger(t: ReturnType<typeof make>, email = "new.person+x@example.com", sub = "s-new") {
  t.p.state.claims = { email, sub };
  t.p.state.nonce = "";
}

const secretOf = (cookie: string) => cookie.split("=")[1]!;

describe("signing up through the provider", () => {
  test("someone new gets an account and an org of their own, and nothing at home", async () => {
    const t = make(signupOn);
    await t.s.admin();
    stranger(t);
    const res = await t.signIn({ next: "/previews" });
    expect(res.headers.get("location")).toBe("/previews");
    const cookie = t.sessionCookie(res)!;
    const user = t.s.users.getByEmail("new.person+x@example.com")!;
    expect(t.s.users.isSsoOnly(user.id)).toBe(true);

    const orgs = new OrgsRepo(t.s.db);
    const org = orgs.bySlug("newpersonx")!;
    expect(org).toMatchObject({ name: "new.person+x@example.com", home: false });
    expect(orgs.limitsOf(org.id)).toMatchObject({ limits: FREE });
    expect(t.s.users.orgsOf(user.id)).toEqual([org.id]);

    const resolved = t.s.sessions.resolve(secretOf(cookie))!;
    expect(resolved.actor.orgId).toBe(org.id);
    expect(resolved.actor.permissions.has("previews.deploy")).toBe(true);
    expect(resolved.user.roleId).not.toBe(ADMIN_ROLE_ID);
    expect(t.s.accounts.listUsers().map((u) => u.email)).toEqual(["ada@example.com"]);
    expect(t.s.actions()).toEqual(
      expect.arrayContaining(["org.created", "user.created", "auth.login"]),
    );

    stranger(t);
    expect(t.sessionCookie(await t.signIn())).toBeDefined();
    expect(orgs.list()).toHaveLength(2);
  });

  test("two people with the same name before the @ get different org slugs", async () => {
    const t = make(signupOn);
    stranger(t, "bo@one.example", "s1");
    await t.signIn();
    stranger(t, "bo@two.example", "s2");
    await t.signIn();
    const orgs = new OrgsRepo(t.s.db);
    expect(orgs.bySlug("bo")).toBeDefined();
    expect(orgs.bySlug("bo2")).toBeDefined();
  });

  test.each([
    ["signup is off", { signup: null }],
    ["no issuer is named", { signup: { issuer: "", limits: FREE } }],
    ["another issuer is named", { signup: { issuer: "https://other.example", limits: FREE } }],
  ])("nobody new gets in when %s", async (_, o) => {
    const t = make(o);
    stranger(t);
    expect((await t.signIn()).headers.get("location")).toBe("/login?sso=no-account");
    expect(t.s.users.getByEmail("new.person+x@example.com")).toBeUndefined();
    expect(new OrgsRepo(t.s.db).list()).toHaveLength(1);
  });

  test("someone who already has an account stays where they are", async () => {
    const t = await withBo(signupOn);
    const cookie = t.sessionCookie(await t.signIn())!;
    expect(t.s.sessions.resolve(secretOf(cookie))!.actor.orgId).toBe(HOME_ORG_ID);
    expect(new OrgsRepo(t.s.db).list()).toHaveLength(1);
  });

  test("a disabled account is refused, not made again", async () => {
    const t = make(signupOn);
    stranger(t);
    await t.signIn();
    const user = t.s.users.getByEmail("new.person+x@example.com")!;
    t.s.users.update(user.id, { disabled: true });
    stranger(t);
    expect((await t.signIn()).headers.get("location")).toBe("/login?sso=no-account");
    expect(new OrgsRepo(t.s.db).list()).toHaveLength(2);
  });
});

describe("slugFor", () => {
  test.each([
    ["Jo.Smith+tag@example.com", [], "josmithtag"],
    ["...@example.com", [], "org"],
    ["averyveryverylongname@example.com", [], "averyveryverylongnam"],
    ["averyveryverylongname@example.com", ["averyveryverylongnam"], "averyveryverylongna2"],
    ["bo@example.com", ["bo", "bo2"], "bo3"],
  ])("%s with %j taken is %s", (email, taken, want) => {
    expect(slugFor(email, (s) => taken.includes(s))).toBe(want);
  });
});
