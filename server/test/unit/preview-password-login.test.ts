import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import type { DefaultPasswordMode } from "@gangway/shared/domain";
import { PreviewGate } from "../../src/net/gate.ts";
import { previewAccess } from "../../src/previews/password.ts";
import type { RouteEntry } from "../../src/routing/table.ts";
import { APP_ORIGIN, entry, HOST, passwords } from "../helpers/preview-password.ts";

async function gateWith(loginDefault = true) {
  const gate = new PreviewGate({
    key: randomBytes(32),
    appOrigin: () => APP_ORIGIN,
    passwords,
    loginDefault: () => loginDefault,
  });
  const own = { mode: "own", ...(await passwords.hash("pw")) } as const;
  const get = (e: RouteEntry, path = "/", cookie?: string) =>
    gate.handle(
      e,
      new Request(`https://${HOST}${path}`, {
        headers: { "sec-fetch-mode": "navigate", ...(cookie ? { cookie } : {}) },
      }),
    ) as Response | null;
  const ticketPath = (e: RouteEntry, skipPassword: boolean) =>
    `/__gangway/auth?ticket=${encodeURIComponent(gate.issueTicket(e, { skipPassword }))}&to=/`;
  const signIn = (e: RouteEntry, skipPassword: boolean) =>
    get(e, ticketPath(e, skipPassword))!.headers.get("set-cookie")!.split(";")[0]!;
  return { gate, own, get, ticketPath, signIn };
}

describe("signed in instead of the password", () => {
  test("with login on, a page load without a cookie bounces through app, not to the form", async () => {
    const t = await gateWith();
    const res = t.get(entry(t.own, { passwordLogin: "on" }), "/x")!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/v1/auth/gate?host=${HOST}&to=%2Fx`);
  });

  test("with login off, or inherit and the switch off, the form shows without a bounce", async () => {
    const on = await gateWith();
    expect(on.get(entry(on.own, { passwordLogin: "off" }))!.status).toBe(401);
    const t = await gateWith(false);
    const e = entry(t.own, { passwordLogin: "inherit" });
    expect(t.get(e)!.status).toBe(401);
    expect(t.gate.gateable(e)).toEqual({ private: false, passwordSkippable: false });
  });

  test("app sends a stranger back to the form for where they were going", async () => {
    const t = await gateWith();
    const res = t.get(entry(t.own, { passwordLogin: "on" }), "/__gangway/password?to=%2Forders")!;
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('name="to" value="/orders"');
  });

  test("a skipping ticket opens it; a plain one earns a cookie that still gets the form", async () => {
    const t = await gateWith();
    const e = entry(t.own, { passwordLogin: "on" });
    expect(t.get(e, "/", t.signIn(e, true))).toBeNull();
    expect(t.get(e, "/", t.signIn(e, false))!.status).toBe(401);
  });

  test("turning the login off retires skip cookies and tickets already handed out", async () => {
    const t = await gateWith();
    const e = entry(t.own, { passwordLogin: "on" });
    const cookie = t.signIn(e, true);
    e.passwordLogin = "off";
    expect(t.get(e, "/", cookie)!.status).toBe(401);
    expect(t.get(e, t.ticketPath(e, true))!.status).toBe(404);
  });

  test("private with a password takes one sign-in that may carry the skip", async () => {
    const t = await gateWith();
    const e = entry(t.own, { passwordLogin: "on", visibility: "private" });
    expect(t.get(e)!.status).toBe(302);
    expect(t.get(e, "/", t.signIn(e, true))).toBeNull();
    expect(t.get(e, "/", t.signIn(e, false))!.status).toBe(401);
  });

  test("an older-format gate cookie opens a private preview but never skips a password", async () => {
    const key = randomBytes(32);
    const payload = `01SHOP0000000000000000000A.${Date.now() + 60_000}`;
    const old = `__Host-gw_pv=${payload}.${createHmac("sha256", key).update(`cookie|${payload}`).digest("base64url")}`;
    const gate = new PreviewGate({ key, appOrigin: () => APP_ORIGIN, passwords });
    const req = () =>
      new Request(`https://${HOST}/`, { headers: { cookie: old, "sec-fetch-mode": "navigate" } });
    expect(gate.check(entry({ mode: "none" }, { visibility: "private" }), req())).toBeNull();
    const withPassword = entry(
      { mode: "own", ...(await passwords.hash("pw")) },
      { visibility: "private", passwordLogin: "on" },
    );
    expect(gate.check(withPassword, req())!.status).toBe(401);
  });
});

describe("passwordLogin only: people signed in to gangway", () => {
  test("the gate bounces to app to log in and never offers the password form", async () => {
    const gate = new PreviewGate({ key: randomBytes(32), appOrigin: () => APP_ORIGIN, passwords });
    const e = entry({ mode: "own", ...(await passwords.hash("pw")) }, { passwordLogin: "only" });
    const res = gate.handle(
      e,
      new Request(`https://${HOST}/x`, { headers: { "sec-fetch-mode": "navigate" } }),
    ) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/v1/auth/gate");
    expect(gate.gateable(e)).toEqual({ private: true, passwordSkippable: false });
    const post = await gate.handle(
      e,
      new Request(`https://${HOST}/__gangway/password`, {
        method: "POST",
        headers: { origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" },
        body: "password=pw&to=/",
      }),
    );
    expect(post!.status).toBe(404);
    const cookie = gate.handle(
      e,
      new Request(
        `https://${HOST}/__gangway/auth?ticket=${encodeURIComponent(gate.issueTicket(e))}&to=/`,
      ),
    ) as Response;
    expect(
      gate.check(
        e,
        new Request(`https://${HOST}/`, {
          headers: { cookie: cookie.headers.get("set-cookie")!.split(";")[0]! },
        }),
      ),
    ).toBeNull();
  });
});

describe("who can open it, as the UI is told", () => {
  type Defaults = { mode?: DefaultPasswordMode; shared?: boolean; login?: boolean };
  const deps = (o: Defaults) => ({
    passwords,
    defaultMode: () => o.mode ?? "off",
    sharedSet: () => o.shared ?? false,
    loginDefault: () => o.login ?? false,
  });
  const loginOn = { login: true };
  const sharedSet = { mode: "shared", shared: true } as const;

  test.each([
    [{}, "unlisted", "set", "inherit", "password"],
    [loginOn, "unlisted", "generated", "inherit", "either"],
    [loginOn, "unlisted", "set", "off", "password"],
    [{}, "unlisted", "set", "on", "either"],
    [{}, "unlisted", "set", "only", "signed-in"],
    [{}, "unlisted", "none", "only", "signed-in"],
    [sharedSet, "unlisted", "inherit", "inherit", "password"],
    [{ mode: "shared", shared: false }, "unlisted", "inherit", "inherit", "open"],
    [{ mode: "generated", shared: true }, "unlisted", "inherit", "inherit", "open"],
    [sharedSet, "unlisted", "none", "on", "open"],
    [{}, "private", "none", "inherit", "signed-in"],
    [{}, "private", "set", "off", "signed-in+password"],
    [{}, "private", "set", "on", "signed-in"],
  ] as const)(
    "defaults %j, %s, password %s, login %s: %s",
    (defaults, visibility, password, passwordLogin, expected) => {
      expect(previewAccess(deps(defaults), { visibility, password, passwordLogin })).toBe(expected);
    },
  );
});
