import { describe, expect, test } from "bun:test";
import { client } from "../helpers/fake-daemon.ts";
import {
  API,
  APP,
  bootE2e,
  browser,
  cookieOf,
  deployPreview,
  setupAdmin,
  signInPlainViewer,
} from "../helpers/boot-e2e.ts";

/** Boot, make the admin, deploy `name` with `body`, and find where its gate bounce lands. */
async function gatedPreview(name: string, body: Record<string, unknown>) {
  const { running } = await bootE2e();
  const raw = browser(running);
  const port = running.listener.port;
  const HOST = `${name}.preview.localhost`;
  const admin = await setupAdmin(running);
  const deployed = await deployPreview(running, { name, ...body });
  const id = ((await deployed.json()) as { preview: { id: string } }).preview.id;
  const bounced = await raw(HOST, "/cookie?x=1");
  const toGate = new URL(bounced.headers.get("location")!);
  const gate = `${toGate.pathname}${toGate.search}`;
  /** Ask the app gate for a ticket with this cookie, and redeem it on the preview. */
  const enter = async (cookie: string) => {
    const ticketed = await raw(APP, gate, { headers: { cookie } });
    const toPreview = new URL(ticketed.headers.get("location")!);
    const redeemed = await raw(HOST, `${toPreview.pathname}${toPreview.search}`);
    return { ticketed, toPreview, redeemed };
  };
  const setLogin = (login: string) =>
    client(running)(API, `/v1/previews/${id}/password`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login }),
    });
  return { running, raw, port, HOST, admin, deployed, id, bounced, toGate, gate, enter, setLogin };
}

describe("a private preview", () => {
  const privatePreview = () => gatedPreview("secret", { visibility: "private" });

  test("bounces a stranger to the app gate, which sends them to log in", async () => {
    const p = await privatePreview();
    expect(p.admin.status).toBe(201);
    expect(p.deployed.status).toBe(201);
    expect(p.bounced.status).toBe(302);
    expect(`${p.toGate.host}${p.toGate.pathname}`).toBe(`${APP}:${p.port}/v1/auth/gate`);
    expect(p.toGate.searchParams.get("to")).toBe("/cookie?x=1");
    const cors = await p.raw(p.HOST, "/cookie", { headers: { "sec-fetch-mode": "cors" } });
    expect(cors.status).toBe(401);

    const anonymous = await p.raw(APP, p.gate);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toStartWith("/login?returnUrl=%2Fv1%2Fauth%2Fgate");
  }, 30_000);

  test.each(["evil.example", "api.preview.localhost", "nope.preview.localhost", ""])(
    "the gate is not an open redirect: %j is refused",
    async (host) => {
      const p = await privatePreview();
      const res = await p.raw(APP, `/v1/auth/gate?host=${host}&to=/`, {
        headers: { cookie: p.admin.session },
      });
      expect(res.status).toBe(404);
    },
    30_000,
  );

  test("a signed-in admin trades a one-use ticket for the preview's own cookie", async () => {
    const p = await privatePreview();
    const { ticketed, toPreview, redeemed } = await p.enter(p.admin.session);
    expect(ticketed.status).toBe(302);
    expect(`${toPreview.host}${toPreview.pathname}`).toBe(`${p.HOST}:${p.port}/__gangway/auth`);
    expect(ticketed.headers.get("referrer-policy")).toBe("no-referrer");
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get("location")).toBe("/cookie?x=1");
    const gateCookie = cookieOf(redeemed);
    expect(gateCookie).toStartWith("__Host-gw_pv=");
    expect((await p.raw(p.HOST, `${toPreview.pathname}${toPreview.search}`)).status).toBe(403);

    const inside = await p.raw(p.HOST, "/cookie?x=1", {
      headers: { cookie: `theme=dark; ${gateCookie}` },
    });
    expect(inside.status).toBe(200);
    expect(await inside.json()).toEqual({ cookie: "theme=dark", path: "/cookie?x=1" });

    // The app session is not a key to the preview, and the preview's cookie is not a session.
    const withSession = await p.raw(p.HOST, "/cookie", { headers: { cookie: p.admin.session } });
    expect(withSession.status).toBe(302);
    expect((await p.raw(APP, "/v1/previews", { headers: { cookie: gateCookie } })).status).toBe(
      401,
    );
    const internal = await p.raw(p.HOST, "/__gangway/whatever", {
      headers: { cookie: gateCookie },
    });
    expect(internal.status).toBe(404);
  }, 30_000);

  test("a role without previews.view_private is refused at the gate, by name", async () => {
    const p = await privatePreview();
    const vic = await signInPlainViewer(p.running, p.admin.session);
    const refused = await p.raw(APP, p.gate, { headers: { cookie: vic } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { detail: string }).detail).toContain(
      "previews.view_private",
    );
  }, 30_000);
});

describe("a password preview with the login rule", () => {
  const passwordPreview = () =>
    gatedPreview("shared", { password: { mode: "set", value: "pw" }, passwordLogin: "on" });
  const previewOf = async (res: Response) =>
    ((await res.json()) as { preview: Record<string, unknown> }).preview;

  test("on: a stranger gets the form, a signed-in user walks straight in", async () => {
    const p = await passwordPreview();
    expect(p.deployed.status).toBe(201);
    expect(p.bounced.status).toBe(302);
    expect(`${p.toGate.host}${p.toGate.pathname}`).toBe(`${APP}:${p.port}/v1/auth/gate`);

    const stranger = await p.raw(APP, p.gate);
    expect(stranger.status).toBe(302);
    const back = new URL(stranger.headers.get("location")!);
    expect(`${back.host}${back.pathname}`).toBe(`${p.HOST}:${p.port}/__gangway/password`);
    const form = await p.raw(p.HOST, `${back.pathname}${back.search}`);
    expect(form.status).toBe(401);
    expect(await form.text()).toContain('name="to" value="/cookie?x=1"');

    const { toPreview, redeemed } = await p.enter(p.admin.session);
    expect(toPreview.pathname).toBe("/__gangway/auth");
    expect(redeemed.headers.get("location")).toBe("/cookie?x=1");
    const inside = await p.raw(p.HOST, "/cookie?x=1", {
      headers: { cookie: `theme=dark; ${cookieOf(redeemed)}` },
    });
    expect(inside.status).toBe(200);
    expect(await inside.json()).toEqual({ cookie: "theme=dark", path: "/cookie?x=1" });
  }, 30_000);

  test("off: the same cookie gets the form and the gate stops issuing tickets", async () => {
    const p = await passwordPreview();
    const gateCookie = cookieOf((await p.enter(p.admin.session)).redeemed);
    expect((await previewOf(await p.setLogin("off"))).passwordLogin).toBe("off");
    const asked = await p.raw(p.HOST, "/cookie", { headers: { cookie: gateCookie } });
    expect(asked.status).toBe(401);
    expect(await asked.text()).toContain("password-protected");
    expect((await p.raw(p.HOST, "/cookie")).status).toBe(401);
    const gate = await p.raw(APP, p.gate, { headers: { cookie: p.admin.session } });
    expect(gate.status).toBe(404);
  }, 30_000);

  test("on, for a role without previews.skip_password, still shows the form", async () => {
    const p = await passwordPreview();
    const vic = await signInPlainViewer(p.running, p.admin.session);
    const back = await p.raw(APP, p.gate, { headers: { cookie: vic } });
    expect(new URL(back.headers.get("location")!).pathname).toBe("/__gangway/password");
  }, 30_000);

  test("inherit asks everyone until the server-wide switch is turned on", async () => {
    const p = await passwordPreview();
    expect(await previewOf(await p.setLogin("inherit"))).toMatchObject({ access: "password" });
    expect((await p.raw(p.HOST, "/cookie")).status).toBe(401);
    await client(p.running)(API, "/v1/settings/preview-password", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "off", login: true }),
    });
    expect((await p.raw(p.HOST, "/cookie")).status).toBe(302);
    const now = await client(p.running)(API, `/v1/previews/${p.id}`);
    expect(await previewOf(now)).toMatchObject({ access: "either" });
  }, 30_000);

  test("only: strangers are sent to log in, the admin walks in, the password is dead", async () => {
    const p = await passwordPreview();
    expect(await previewOf(await p.setLogin("only"))).toMatchObject({
      passwordLogin: "only",
      access: "signed-in",
    });
    const toLogin = await p.raw(APP, p.gate);
    expect(toLogin.headers.get("location")).toStartWith("/login?returnUrl=");
    const { toPreview, redeemed } = await p.enter(p.admin.session);
    expect(toPreview.pathname).toBe("/__gangway/auth");
    const inside = await p.raw(p.HOST, "/cookie", { headers: { cookie: cookieOf(redeemed) } });
    expect(inside.status).toBe(200);
    const withPassword = await p.raw(p.HOST, "/__gangway/password", {
      method: "POST",
      headers: {
        origin: `https://${p.HOST}:${p.port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "password=pw&to=/",
    });
    expect(withPassword.status).toBe(404);
  }, 30_000);
});
