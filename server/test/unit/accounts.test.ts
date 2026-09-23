import { describe, expect, test } from "bun:test";
import { ALL_PERMISSIONS } from "../../../shared/src/permissions.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Logger } from "../../src/logger.ts";
import { META, PASSWORD, setupAccounts as setup } from "../helpers/accounts.ts";

const MIN = 60_000,
  DAY = 86_400_000;

describe("login", () => {
  test("the right password gets a session whose actor holds the role's permissions", async () => {
    const s = setup();
    await s.admin();
    const { user, secret } = await s.accounts.login("ada@example.com", PASSWORD, META);
    expect(user).toMatchObject({ email: "ada@example.com", roleId: "admin" });
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const resolved = s.sessions.resolve(secret)!;
    expect(resolved.actor).toMatchObject({ kind: "user", userId: user.id, roleId: "admin" });
    expect(resolved.actor.permissions.size).toBe(ALL_PERMISSIONS.length);
    expect(resolved.session).toMatchObject({ ip: "203.0.113.7", userAgent: "test-agent" });
  });

  test("unknown email, wrong password and disabled account are ONE error, and each costs a real verify", async () => {
    const s = setup();
    await s.admin();
    const bob = await s.accounts.createUser(
      s.sessions.resolve((await s.accounts.login("ada@example.com", PASSWORD, META)).secret)!.actor,
      { email: "bob@example.com", password: PASSWORD, roleId: "member" },
    );
    await s.accounts.updateUser(
      s.sessions.resolve((await s.accounts.login("ada@example.com", PASSWORD, META)).secret)!.actor,
      bob.id,
      { disabled: true },
    );

    const calls: string[] = [];
    const { verify, verifyDummy } = s.passwords;
    s.passwords.verify = function (...a) {
      calls.push("verify");
      return verify.apply(this, a);
    };
    s.passwords.verifyDummy = function (...a) {
      calls.push("dummy");
      return verifyDummy.apply(this, a);
    };

    const errors = [];
    for (const [email, pw] of [
      ["nobody@example.com", PASSWORD],
      ["ada@example.com", "not the password!"],
      ["bob@example.com", PASSWORD],
    ] as const) {
      errors.push(
        await s.accounts
          .login(email, pw, META)
          .catch((e) => ({ code: e.code, status: e.status, message: e.message })),
      );
    }
    expect(new Set(errors.map((e) => JSON.stringify(e))).size).toBe(1);
    expect(errors[0]).toEqual({
      code: "unauthorized",
      status: 401,
      message: "wrong email or password",
    });
    // dummy -> verify: real -> verify, disabled -> dummy -> verify. Nobody got a free "no".
    expect(calls.filter((c) => c === "verify")).toHaveLength(3);
  });

  test("5 failures lock the account: 429 with Retry-After, the RIGHT password is refused too, and scrypt is not run", async () => {
    const s = setup();
    await s.admin();
    for (let i = 0; i < 5; i++)
      await expect(
        s.accounts.login("ada@example.com", "wrong wrong wrong", META),
      ).rejects.toMatchObject({ status: 401 });

    let ran = 0;
    const { verify } = s.passwords;
    s.passwords.verify = function (...a) {
      ran++;
      return verify.apply(this, a);
    };
    await expect(s.accounts.login("ada@example.com", PASSWORD, META)).rejects.toMatchObject({
      status: 429,
      headers: { "retry-after": "60" },
    });
    expect(ran).toBe(0);

    s.clock.t += MIN;
    expect((await s.accounts.login("ada@example.com", PASSWORD, META)).user.email).toBe(
      "ada@example.com",
    );
  });

  test("a spray of blocked attempts writes ONE audit row, not one per attempt", async () => {
    const s = setup();
    await s.admin();
    for (let i = 0; i < 5; i++)
      await s.accounts.login("ada@example.com", "wrong wrong wrong", META).catch(() => {});
    for (let i = 0; i < 50; i++)
      await s.accounts.login("ada@example.com", "wrong wrong wrong", META).catch(() => {});
    expect(s.actions().filter((a) => a === "auth.login.blocked")).toHaveLength(1);
    expect(s.actions().filter((a) => a === "auth.login.failed")).toHaveLength(5);
  });

  test("a hash made at an older cost is upgraded by a successful login", async () => {
    const s = setup();
    const { user } = await s.admin();
    const { Passwords } = await import("../../src/auth/password.ts");
    s.users.setPassword(user.id, await new Passwords({ ln: 11 }).hash(PASSWORD));
    expect(s.users.credentials(user.id)!.hash).toContain("ln=11");
    await s.accounts.login("ada@example.com", PASSWORD, META);
    expect(s.users.credentials(user.id)!.hash).toContain("ln=10");
  });

  test("nothing in the audit log is a password", async () => {
    const s = setup();
    await s.admin();
    await s.accounts.login("ada@example.com", "a wrong guess 12345", META).catch(() => {});
    await s.accounts.login("ada@example.com", PASSWORD, META);
    const dump = JSON.stringify(s.auditRepo.page({ limit: 200 }));
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain("a wrong guess");
    expect(dump).not.toContain("scrypt$");
  });
});

describe("first-run setup", () => {
  test("racing requests make exactly one admin; the loser sees a 404, as if setup were never there", async () => {
    const s = setup();
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => s.accounts.setupFirstAdmin(`admin${i}@example.com`, PASSWORD, META)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 404 });
    expect(s.users.count()).toBe(1);
    expect(s.users.list()[0]!.roleId).toBe("admin");
    expect(s.actions()).toEqual(["auth.setup"]);
  });

  test("Bootstrap is pending exactly while there are no users", async () => {
    const s = setup();
    const b = new Bootstrap(() => s.users.count());
    const url = b.url("https://app.preview.localhost:8443")!;
    expect(url).toMatch(
      /^https:\/\/app\.preview\.localhost:8443\/setup\?token=gw_setup_[A-Za-z0-9_-]{43}$/,
    );
    const token = new URL(url).searchParams.get("token")!;
    expect(b.check("gw_setup_wrong")).toBe(false);
    expect(b.check(token)).toBe(true);
    expect(b.check(token)).toBe(true); // a bad password must not burn the link

    await s.admin();
    expect(b.pending).toBe(false);
    expect(b.check(token)).toBe(false);
    expect(b.url("https://app.preview.localhost:8443")).toBeNull();
  });

  test("a boot with users already present mints no secret at all", async () => {
    const s = setup();
    await s.admin();
    const b = new Bootstrap(() => s.users.count());
    expect(b.pending).toBe(false);
    expect(b.url("https://x")).toBeNull();
    expect(b.check("")).toBe(false);
  });

  test("the setup URL is redacted if it ever reaches the logger", () => {
    const lines: string[] = [];
    const url = new Bootstrap(() => 0).url("https://app.example.dev")!;
    new Logger("info", {}, (l) => lines.push(l)).info("oops", { url });
    expect(lines.join("")).not.toContain(new URL(url).searchParams.get("token")!);
  });
});

describe("administering users", () => {
  const withAdmin = async () => {
    const s = setup();
    const { user, secret } = await s.admin();
    return { ...s, ada: user, actor: s.sessions.resolve(secret)!.actor };
  };

  test("create: the role must exist and the email must be free", async () => {
    const s = await withAdmin();
    await expect(
      s.accounts.createUser(s.actor, {
        email: "bob@example.com",
        password: PASSWORD,
        roleId: "wizard",
      }),
    ).rejects.toMatchObject({ status: 422 });
    await s.accounts.createUser(s.actor, {
      email: "bob@example.com",
      password: PASSWORD,
      roleId: "viewer",
    });
    await expect(
      s.accounts.createUser(s.actor, {
        email: "bob@example.com",
        password: PASSWORD,
        roleId: "viewer",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("the last enabled admin cannot be demoted or disabled -- not even by themselves", async () => {
    const s = await withAdmin();
    await expect(
      s.accounts.updateUser(s.actor, s.ada.id, { roleId: "member" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.accounts.updateUser(s.actor, s.ada.id, { disabled: true }),
    ).rejects.toMatchObject({ status: 409 });

    const bob = await s.accounts.createUser(s.actor, {
      email: "bob@example.com",
      password: PASSWORD,
      roleId: "admin",
    });
    await s.accounts.updateUser(s.actor, bob.id, { disabled: true });
    // a DISABLED second admin is not a way back in
    await expect(
      s.accounts.updateUser(s.actor, s.ada.id, { roleId: "member" }),
    ).rejects.toMatchObject({ status: 409 });

    await s.accounts.updateUser(s.actor, bob.id, { disabled: false });
    expect((await s.accounts.updateUser(s.actor, s.ada.id, { roleId: "member" })).roleId).toBe(
      "member",
    );
  });

  test("a role change applies to a session that is ALREADY open, on its next request", async () => {
    const s = await withAdmin();
    const bob = await s.accounts.createUser(s.actor, {
      email: "bob@example.com",
      password: PASSWORD,
      roleId: "member",
    });
    const { secret } = await s.accounts.login("bob@example.com", PASSWORD, META);
    expect(s.sessions.resolve(secret)!.actor.permissions.has("previews.destroy")).toBe(true);

    await s.accounts.updateUser(s.actor, bob.id, { roleId: "viewer" });
    expect(s.sessions.resolve(secret)!.actor.permissions.has("previews.destroy")).toBe(false);

    s.roles.set("viewer", ["previews.read", "previews.destroy"]);
    expect(s.sessions.resolve(secret)!.actor.permissions.has("previews.destroy")).toBe(true);
  });

  test("disabling ends every session at once; so does a password reset, and the new password works", async () => {
    const s = await withAdmin();
    const bob = await s.accounts.createUser(s.actor, {
      email: "bob@example.com",
      password: PASSWORD,
      roleId: "member",
    });
    const first = (await s.accounts.login("bob@example.com", PASSWORD, META)).secret;
    await s.accounts.updateUser(s.actor, bob.id, { password: "an entirely new password" });
    expect(s.sessions.resolve(first)).toBeNull();
    await expect(s.accounts.login("bob@example.com", PASSWORD, META)).rejects.toMatchObject({
      status: 401,
    });

    const second = (await s.accounts.login("bob@example.com", "an entirely new password", META))
      .secret;
    await s.accounts.updateUser(s.actor, bob.id, { disabled: true });
    expect(s.sessions.resolve(second)).toBeNull();
  });

  test("the audit trail says who changed what, with before and after", async () => {
    const s = await withAdmin();
    const bob = await s.accounts.createUser(s.actor, {
      email: "bob@example.com",
      password: PASSWORD,
      roleId: "member",
    });
    await s.accounts.updateUser(s.actor, bob.id, {
      roleId: "viewer",
      password: "an entirely new password",
    });
    const entry = s.auditRepo.page({ limit: 1 }).entries[0]!;
    expect(entry).toMatchObject({
      actorType: "user",
      actorId: s.ada.id,
      action: "user.updated",
      target: bob.id,
      old: { roleId: "member", disabled: false },
      new: { roleId: "viewer", disabled: false, passwordReset: true },
    });
    expect(JSON.stringify(entry)).not.toContain("entirely new");
  });
});

describe("changing your own password", () => {
  test("needs the current one; ends every OTHER session; keeps the one in hand", async () => {
    const s = setup();
    await s.admin();
    const here = (await s.accounts.login("ada@example.com", PASSWORD, META)).secret;
    const elsewhere = (await s.accounts.login("ada@example.com", PASSWORD, META)).secret;
    const actor = s.sessions.resolve(here)!.actor;

    await expect(
      s.accounts.changeOwnPassword(actor, "not my password!", "a brand new password", META),
    ).rejects.toMatchObject({ status: 403 });
    await s.accounts.changeOwnPassword(actor, PASSWORD, "a brand new password", META);
    expect(s.sessions.resolve(here)).not.toBeNull();
    expect(s.sessions.resolve(elsewhere)).toBeNull();
    expect(
      (await s.accounts.login("ada@example.com", "a brand new password", META)).user.email,
    ).toBe("ada@example.com");
  });

  test("it is a password oracle for whoever holds a session, so it shares login's lockout", async () => {
    const s = setup();
    await s.admin();
    const actor = s.sessions.resolve(
      (await s.accounts.login("ada@example.com", PASSWORD, META)).secret,
    )!.actor;
    for (let i = 0; i < 5; i++)
      await s.accounts
        .changeOwnPassword(actor, `guess number ${i} here`, "a brand new password", META)
        .catch(() => {});
    await expect(
      s.accounts.changeOwnPassword(actor, PASSWORD, "a brand new password", META),
    ).rejects.toMatchObject({ status: 429 });
  });

  test("a token is not a person", async () => {
    const s = setup();
    const { tokenActor } = await import("../../src/auth/actor.ts");
    await expect(
      s.accounts.changeOwnPassword(
        tokenActor("env:admin", ["admin"]),
        "x",
        "a brand new password",
        META,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("session lifetime", () => {
  test("a malformed cookie is refused without touching the database", async () => {
    const s = setup();
    await s.admin();
    let reads = 0;
    const { findActive } = s.sessionsRepo;
    s.sessionsRepo.findActive = function (...a) {
      reads++;
      return findActive.apply(this, a);
    };
    for (const junk of [
      "",
      "short",
      "x".repeat(10_000),
      "has spaces in it and is forty-three chars!!",
      "../../etc/passwd",
    ])
      expect(s.sessions.resolve(junk)).toBeNull();
    expect(reads).toBe(0);
  });

  test("the raw cookie value is nowhere in the database", async () => {
    const s = setup();
    const { secret } = await s.admin();
    expect(JSON.stringify(s.db.query("SELECT * FROM sessions"))).not.toContain(secret);
  });

  test("use keeps it alive; 7 idle days end it; 30 days end it however busy", async () => {
    const s = setup();
    const { secret } = await s.admin();
    for (let day = 0; day < 29; day++) {
      s.clock.t += DAY;
      expect(s.sessions.resolve(secret)).not.toBeNull();
    }
    s.clock.t += DAY + 1;
    expect(s.sessions.resolve(secret)).toBeNull(); // the absolute cap, despite daily use

    const again = (await s.accounts.login("ada@example.com", PASSWORD, META)).secret;
    s.clock.t += 7 * DAY + 1;
    expect(s.sessions.resolve(again)).toBeNull(); // idle
  });

  test("the sliding write is throttled: a busy session writes once per window, not once per request", async () => {
    const s = setup();
    const { secret } = await s.admin();
    let writes = 0;
    const { touch } = s.sessionsRepo;
    s.sessionsRepo.touch = function (...a) {
      const wrote = touch.apply(this, a);
      if (wrote) writes++;
      return wrote;
    };
    for (let i = 0; i < 100; i++) {
      s.clock.t += 1000;
      s.sessions.resolve(secret);
    }
    expect(writes).toBe(0); // 100 seconds < the 5 minute window
    s.clock.t += 5 * MIN;
    s.sessions.resolve(secret);
    expect(writes).toBe(1);
  });

  test("logout ends the session and is recorded; purge reclaims expired rows", async () => {
    const s = setup();
    const { secret } = await s.admin();
    s.accounts.logout(s.sessions.resolve(secret)!.actor);
    expect(s.sessions.resolve(secret)).toBeNull();
    expect(s.actions()).toContain("auth.logout");

    await s.accounts.login("ada@example.com", PASSWORD, META);
    s.clock.t += 8 * DAY;
    expect(s.sessions.purge()).toBe(1);
  });
});
