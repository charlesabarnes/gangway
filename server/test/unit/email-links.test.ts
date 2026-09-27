import { describe, expect, test } from "bun:test";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { mailSettingsRoutes } from "../../src/app/routes/settings.ts";
import { userRoutes } from "../../src/app/routes/users.ts";
import { staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { LoginLimiter } from "../../src/auth/limiter.ts";
import { EmailLinks } from "../../src/auth/links.ts";
import { Mailer, type Mail } from "../../src/mail/mailer.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { META, PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { silentLogger } from "../helpers/logger.ts";

const HOUR = 3_600_000;
const NEW_PASSWORD = "a brand new passphrase";
const TOKEN = "gw_mail_test_admin_token_0123456789";

function setup(o: { configured?: boolean; fail?: string } = {}) {
  const s = setupAccounts();
  const sent: (Mail & { from: string })[] = [];
  const transports: string[] = [];
  const settings = new Settings({}, new MemorySettingsStore());
  if (o.configured !== false) {
    settings.set(SETTINGS.mailSmtpUrl, "smtp://user:pw@smtp.example.com:587");
    settings.set(SETTINGS.mailFrom, "gangway <noreply@example.com>");
  }
  const mailer = new Mailer({
    url: () => settings.get(SETTINGS.mailSmtpUrl),
    from: () => settings.get(SETTINGS.mailFrom),
    transport: (url) => {
      transports.push(url);
      return async (m) => {
        if (o.fail) throw new Error(o.fail);
        sent.push(m);
      };
    },
  });
  const links = new EmailLinks({
    db: s.db,
    users: s.users,
    links: s.userLinks,
    sessions: s.sessions,
    passwords: s.passwords,
    mailer,
    audit: s.audit,
    limiter: new LoginLimiter({ emailFree: 1, ipMax: 10 }, s.now),
    appOrigin: () => "https://app.example.com",
    logger: silentLogger(),
    onCredentialsRevoked: (id) => s.userLinks.deleteForUser(id),
  });
  // The background send of a reset request lands after a tick.
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const secretOf = (m: Mail) => /\/set-password#([A-Za-z0-9_-]{43})$/m.exec(m.text)![1]!;
  return { ...s, settings, mailer, links, sent, transports, flush, secretOf };
}

async function withBob(t: ReturnType<typeof setup>, o: { invite?: boolean } = {}) {
  await t.admin();
  const actor = t.sessions.resolve(
    (await t.accounts.login("ada@example.com", PASSWORD, META)).secret,
  )!.actor;
  const bob = await t.accounts.createUser(actor, {
    email: "bob@example.com",
    roleId: "member",
    ...(o.invite ? {} : { password: PASSWORD }),
  });
  return { actor, bob };
}

describe("mailer", () => {
  test("is unconfigured until both an SMTP URL and a From address are set", async () => {
    const t = setup({ configured: false });
    expect(t.mailer.configured).toBe(false);
    t.settings.set(SETTINGS.mailSmtpUrl, "smtp://smtp.example.com");
    expect(t.mailer.configured).toBe(false);
    await expect(t.mailer.send({ to: "a@b.c", subject: "s", text: "t" })).rejects.toMatchObject({
      status: 409,
    });
    t.settings.set(SETTINGS.mailFrom, "noreply@example.com");
    expect(t.mailer.configured).toBe(true);
  });

  test("reuses one transport per URL and builds a new one when the URL changes", async () => {
    const t = setup();
    const m = { to: "a@b.c", subject: "s", text: "t" };
    await t.mailer.send(m);
    await t.mailer.send(m);
    t.settings.set(SETTINGS.mailSmtpUrl, "smtps://smtp.example.com:465");
    await t.mailer.send(m);
    expect(t.transports).toEqual([
      "smtp://user:pw@smtp.example.com:587",
      "smtps://smtp.example.com:465",
    ]);
    expect(t.sent[0]!.from).toBe("gangway <noreply@example.com>");
  });

  test("a relay's refusal is a 422 in its own words", async () => {
    const t = setup({ fail: "Invalid login: 535 Authentication failed" });
    await expect(t.mailer.send({ to: "a@b.c", subject: "s", text: "t" })).rejects.toMatchObject({
      status: 422,
      message: "the mail server refused: Invalid login: 535 Authentication failed",
    });
  });

  test("the settings refuse what is not an SMTP URL or an address", () => {
    const t = setup();
    for (const bad of ["http://smtp.example.com", "smtp://", "smtp.example.com:587"])
      expect(() => t.settings.set(SETTINGS.mailSmtpUrl, bad)).toThrow();
    for (const bad of ["noreply", "gangway <noreply>", "a@b.c\r\nBcc: x@y.z"])
      expect(() => t.settings.set(SETTINGS.mailFrom, bad)).toThrow();
    t.settings.set(SETTINGS.mailFrom, "noreply@example.com");
    t.settings.set(SETTINGS.mailFrom, "");
    t.settings.set(SETTINGS.mailSmtpUrl, "");
  });
});

describe("password reset", () => {
  test("a link resets the password once, logs in, and logs out everywhere else", async () => {
    const t = setup();
    await withBob(t);
    const before = await t.accounts.login("bob@example.com", PASSWORD, META);

    t.links.requestReset("bob@example.com", META);
    await t.flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!).toMatchObject({
      to: "bob@example.com",
      subject: "Reset your gangway password",
    });
    expect(t.sent[0]!.text).toContain("expires in an hour");
    const secret = t.secretOf(t.sent[0]!);
    expect(t.links.inspect(secret)).toEqual({ email: "bob@example.com", purpose: "reset" });

    const { user, secret: session } = await t.links.redeem(secret, NEW_PASSWORD, META);
    expect(user.email).toBe("bob@example.com");
    expect(t.sessions.resolve(session)).toBeTruthy();
    expect(t.sessions.resolve(before.secret)).toBeFalsy();
    await t.accounts.login("bob@example.com", NEW_PASSWORD, META);
    await expect(t.accounts.login("bob@example.com", PASSWORD, META)).rejects.toMatchObject({
      status: 401,
    });
    await expect(t.links.redeem(secret, "yet another passphrase", META)).rejects.toMatchObject({
      status: 404,
    });
    expect(t.actions()).toContain("auth.password.reset");
  });

  test("the database holds only a hash of the emailed secret", async () => {
    const t = setup();
    await withBob(t);
    t.links.requestReset("bob@example.com", META);
    await t.flush();
    const secret = t.secretOf(t.sent[0]!);
    const rows = t.db.query<{ id: string }>("SELECT id FROM user_links");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toContain(secret);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an unknown or disabled address gets the same answer and no email", async () => {
    const t = setup();
    const { actor, bob } = await withBob(t);
    await t.accounts.updateUser(actor, bob.id, { disabled: true });
    expect(t.links.requestReset("nobody@example.com", META)).toBeUndefined();
    expect(t.links.requestReset("bob@example.com", META)).toBeUndefined();
    await t.flush();
    expect(t.sent).toEqual([]);
  });

  test("asking again straight away is refused, and only the newest link works", async () => {
    const t = setup();
    await withBob(t);
    t.links.requestReset("bob@example.com", META);
    expect(() => t.links.requestReset("bob@example.com", META)).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    t.clock.t += 5 * 60_000;
    t.links.requestReset("bob@example.com", META);
    await t.flush();
    const [first, second] = t.sent.map(t.secretOf);
    expect(() => t.links.inspect(first!)).toThrow(expect.objectContaining({ status: 404 }));
    expect(t.links.inspect(second!).purpose).toBe("reset");
  });

  test("a link expires after an hour", async () => {
    const t = setup();
    await withBob(t);
    t.links.requestReset("bob@example.com", META);
    await t.flush();
    t.clock.t += HOUR;
    await expect(t.links.redeem(t.secretOf(t.sent[0]!), NEW_PASSWORD, META)).rejects.toMatchObject({
      status: 404,
    });
    expect(t.userLinks.purge()).toBe(1);
  });

  test("an admin's new password or disabling the account kills the outstanding link", async () => {
    const t = setup();
    const { actor, bob } = await withBob(t);
    t.links.requestReset("bob@example.com", META);
    await t.flush();
    await t.accounts.updateUser(actor, bob.id, { password: "set by the admin, handed over" });
    expect(() => t.links.inspect(t.secretOf(t.sent[0]!))).toThrow(
      expect.objectContaining({ status: 404 }),
    );

    t.clock.t += HOUR;
    await t.links.sendFor(actor, t.users.get(bob.id)!);
    await t.accounts.updateUser(actor, bob.id, { disabled: true });
    expect(() => t.links.inspect(t.secretOf(t.sent[1]!))).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  test("without email set up, asking is refused as unavailable", async () => {
    const t = setup({ configured: false });
    await withBob(t);
    expect(t.links.available).toBe(false);
    expect(() => t.links.requestReset("bob@example.com", META)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });
});

describe("invitations", () => {
  test("an invited account cannot log in until its link sets a password", async () => {
    const t = setup();
    const { actor, bob } = await withBob(t, { invite: true });
    expect(bob.invited).toBe(true);
    expect(await t.links.sendFor(actor, bob)).toBe("invite");
    const mail = t.sent[0]!;
    expect(mail.subject).toBe("You're invited to gangway at app.example.com");
    expect(mail.text).toContain("ada@example.com added you");
    expect(mail.text).toContain("expires in 7 days");

    const secret = t.secretOf(mail);
    expect(t.links.inspect(secret)).toEqual({ email: "bob@example.com", purpose: "invite" });
    await t.links.redeem(secret, NEW_PASSWORD, META);
    expect(t.users.get(bob.id)!.invited).toBe(false);
    await t.accounts.login("bob@example.com", NEW_PASSWORD, META);
    expect(t.actions()).toEqual(expect.arrayContaining(["user.link.sent", "auth.invite.accepted"]));
  });

  test("the invitation lasts a week, and forgot-password sends it again", async () => {
    const t = setup();
    const { actor, bob } = await withBob(t, { invite: true });
    await t.links.sendFor(actor, bob);
    t.clock.t += 6 * 24 * HOUR;
    expect(t.links.inspect(t.secretOf(t.sent[0]!)).purpose).toBe("invite");

    t.links.requestReset("bob@example.com", META);
    await t.flush();
    expect(t.sent[1]!.subject).toStartWith("You're invited");
  });

  test("an admin's password for an invited account ends the invitation", async () => {
    const t = setup();
    const { actor, bob } = await withBob(t, { invite: true });
    const after = await t.accounts.updateUser(actor, bob.id, { password: PASSWORD });
    expect(after.invited).toBe(false);
    await t.accounts.login("bob@example.com", PASSWORD, META);
  });

  test("a disabled account is not sent a link", async () => {
    const t = setup();
    const { actor, bob } = await withBob(t, { invite: true });
    const off = await t.accounts.updateUser(actor, bob.id, { disabled: true });
    await expect(t.links.sendFor(actor, off)).rejects.toMatchObject({ status: 409 });
    expect(t.sent).toEqual([]);
  });
});

describe("over HTTP", () => {
  function http(o: { configured?: boolean; fail?: string } = {}) {
    const t = setup(o);
    const auth = {
      verifyToken: staticTokenVerifier(TOKEN),
      resolveSession: (secret: string) => t.sessions.resolve(secret)?.actor ?? null,
      originFor: (host: string) => `https://${host}`,
    };
    const app = createApp({
      ...auth,
      logger: silentLogger(),
      v1: (api) => {
        userRoutes(api, t.accounts, t.links);
        mailSettingsRoutes(api, t.audit, t.mailer);
      },
      publicV1: (pub) =>
        authRoutes(pub, {
          auth,
          accounts: t.accounts,
          bootstrap: new Bootstrap(() => t.users.count()),
          links: t.links,
          roles: t.roles,
          sessionMaxAgeSec: 60,
        }),
    });
    const on = (surface: "app" | "api") => {
      const h = surfaceHandler(app, surface);
      const host = `${surface}.preview.localhost`;
      return (path: string, json?: unknown, headers: Record<string, string> = {}) =>
        Promise.resolve(
          h(
            new Request(`https://${host}${path}`, {
              method: json === undefined ? "GET" : "POST",
              headers: { host, "content-type": "application/json", ...headers },
              ...(json === undefined ? {} : { body: JSON.stringify(json) }),
            }),
            { clientIp: "203.0.113.7" },
          ),
        );
    };
    const bearer = { authorization: `Bearer ${TOKEN}` };
    return { t, app: on("app"), api: on("api"), bearer };
  }

  test("the anonymous session says whether forgot-password is offered", async () => {
    for (const configured of [true, false]) {
      const { app } = http({ configured });
      expect(await (await app("/v1/auth/session")).json()).toMatchObject({
        authenticated: false,
        passwordReset: configured,
      });
    }
  });

  test("forgot password, open the link, choose a password: logged in", async () => {
    const { t, app } = http();
    await withBob(t);
    const asked = await app("/v1/auth/password-reset", { email: " Bob@Example.com " });
    expect(asked.status).toBe(202);
    const unknown = await app("/v1/auth/password-reset", { email: "nobody@example.com" });
    expect(unknown.status).toBe(202);
    await t.flush();
    expect(t.sent).toHaveLength(1);
    const token = t.secretOf(t.sent[0]!);

    const opened = await app("/v1/auth/link", { token });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ email: "bob@example.com", purpose: "reset" });

    const short = await app("/v1/auth/link/redeem", { token, password: "short" });
    expect(short.status).toBe(422);
    const done = await app("/v1/auth/link/redeem", { token, password: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect(done.headers.get("set-cookie")).toContain("HttpOnly");
    expect(((await done.json()) as { user: { email: string } }).user.email).toBe("bob@example.com");
    expect((await app("/v1/auth/link", { token })).status).toBe(404);
  });

  test("a browser on another origin cannot ask for a reset", async () => {
    const { app } = http();
    const res = await app(
      "/v1/auth/password-reset",
      { email: "bob@example.com" },
      { origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
  });

  test("an admin invites by email, or is told email is not set up", async () => {
    const { t, api, bearer } = http();
    await t.admin();
    const res = await api(
      "/v1/users",
      { email: "cy@example.com", roleId: "member", invite: true },
      bearer,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string } };
    expect(body).toMatchObject({
      user: { email: "cy@example.com", invited: true },
      invite: { sent: true },
    });
    expect(t.sent[0]!.text).toContain("An admin added you");
    const list = (await (await api("/v1/users", undefined, bearer)).json()) as { email: boolean };
    expect(list.email).toBe(true);

    const resend = await api(`/v1/users/${body.user.id}/email-link`, {}, bearer);
    expect(await resend.json()).toEqual({ sent: "invite" });

    const both = await api(
      "/v1/users",
      { email: "di@example.com", roleId: "member", invite: true, password: PASSWORD },
      bearer,
    );
    expect(both.status).toBe(422);

    const off = http({ configured: false });
    await off.t.admin();
    const refused = await off.api(
      "/v1/users",
      { email: "cy@example.com", roleId: "member", invite: true },
      off.bearer,
    );
    expect(refused.status).toBe(409);
    expect(off.t.users.getByEmail("cy@example.com")).toBeUndefined();
  });

  test("a failed invitation still creates the account and says why", async () => {
    const { t, api, bearer } = http({ fail: "connect ECONNREFUSED 10.0.0.1:587" });
    await t.admin();
    const res = await api(
      "/v1/users",
      { email: "cy@example.com", roleId: "member", invite: true },
      bearer,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      user: { email: "cy@example.com", invited: true },
      invite: { sent: false, error: "the mail server refused: connect ECONNREFUSED 10.0.0.1:587" },
    });
  });

  test("a test email goes to the address given, or the relay's error comes back", async () => {
    const ok = http();
    const sent = await ok.api("/v1/settings/mail/test", { to: "ada@example.com" }, ok.bearer);
    expect(sent.status).toBe(204);
    expect(ok.t.sent[0]).toMatchObject({
      to: "ada@example.com",
      subject: "gangway can send email",
    });

    const bad = http({ fail: "Invalid login: 535" });
    const res = await bad.api("/v1/settings/mail/test", { to: "ada@example.com" }, bad.bearer);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      "the mail server refused: Invalid login: 535",
    );
  });
});
