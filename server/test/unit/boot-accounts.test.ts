import { expect, test } from "bun:test";
import { boot } from "../../src/boot.ts";
import { loadConfig } from "../../src/config.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { Logger } from "../../src/logger.ts";
import { tempDir } from "../helpers/db.ts";
import { onCleanup } from "../helpers/cleanup.ts";
import { freePort } from "../helpers/free-port.ts";

const PASSWORD = "correct horse battery staple";
const ADMIN_TOKEN = "gw_boot_accounts_token_0123456789ab";

async function start(stateDir: string, env: Record<string, string> = {}) {
  const announced: string[] = [];
  const logged: string[] = [];
  const config = loadConfig(
    {
      GANGWAY_STATE_DIR: stateDir,
      GANGWAY_LISTEN_ADDRESS: "127.0.0.1",
      GANGWAY_LISTEN_PORT: String(await freePort()),
      GANGWAY_LISTEN_HTTP_PORT: "",
      GANGWAY_ADMIN_TOKEN: ADMIN_TOKEN,
      GANGWAY_RECONCILE_INTERVAL_MS: "0",
      ...env,
    },
    {},
  );
  config.publicPort = config.listenPort;
  const never = (): never => {
    throw new Error("this test never deploys");
  };
  const compose: ComposeRunner = { stream: never, capture: never };
  const clients = {
    for: () => ({
      hostId: "local",
      info: async () => ({ Name: "test-daemon", OperatingSystem: "Linux" }),
      listContainers: async () => [],
      stopContainer: async () => {},
    }),
  };
  const running = await boot(config, {
    compose,
    clients,
    announce: (t) => announced.push(t),
    logger: new Logger("debug", {}, (l) => logged.push(l)),
  });
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await running.stop();
    }
  };
  onCleanup(stop);

  const origin = (label: string) => `https://${label}.preview.localhost:${running.listener.port}`;
  const call = (label: string, path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`https://127.0.0.1:${running.listener.port}${path}`, {
      ...init,
      headers: {
        host: `${label}.preview.localhost:${running.listener.port}`,
        ...(init.json === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers as Record<string, string> | undefined),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      tls: { rejectUnauthorized: false },
      redirect: "manual",
    } as RequestInit);
  return { running, announced, logged, call, origin, stop };
}

test("first run announces an unlogged setup URL that makes the admin, once", async () => {
  const dir = tempDir();

  const first = await start(dir);
  const url = first.running.setupUrl!;
  expect(url).toStartWith(`${first.origin("app")}/setup?token=gw_setup_`);
  expect(first.announced.join("\n")).toContain(url);
  const token = new URL(url).searchParams.get("token")!;
  expect(first.logged.join("\n")).not.toContain(token);

  expect(await (await first.call("app", "/v1/auth/session")).json()).toEqual({
    authenticated: false,
    setupRequired: true,
  });

  const made = await first.call("app", "/v1/auth/setup", {
    method: "POST",
    json: { token, email: "ada@example.com", password: PASSWORD },
    headers: { origin: first.origin("app") },
  });
  expect(made.status).toBe(201);
  const cookie = made.headers.get("set-cookie")!.split(";")[0]!;

  // A mutation needs the public origin, which is built from the public port.
  expect((await first.call("app", "/v1/previews", { headers: { cookie } })).status).toBe(200);
  expect((await first.call("app", "/v1/audit", { headers: { cookie } })).status).toBe(200);
  expect(
    (await first.call("app", "/v1/auth/logout", { method: "POST", headers: { cookie } })).status,
  ).toBe(403);
  expect((await first.call("api", "/v1/previews", { headers: { cookie } })).status).toBe(401);

  expect(
    (
      await first.call("api", "/v1/previews", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
    ).status,
  ).toBe(200);

  const audit = (await (await first.call("app", "/v1/audit", { headers: { cookie } })).json()) as {
    entries: { action: string; new: Record<string, unknown> }[];
  };
  expect(audit.entries.map((e) => e.action)).toEqual(["auth.setup"]);
  expect(audit.entries[0]!.new).toMatchObject({
    email: "ada@example.com",
    roleId: "admin",
    ip: "127.0.0.1",
  });
  expect(first.logged.join("\n")).not.toContain(PASSWORD);

  await first.stop();

  // The session lives in SQLite, so it survives the restart.
  const second = await start(dir);
  expect(second.running.setupUrl).toBeNull();
  expect(second.announced.join("\n")).not.toContain("setup");
  expect(await (await second.call("app", "/v1/auth/session")).json()).toEqual({
    authenticated: false,
    setupRequired: false,
  });
  expect(
    (
      await second.call("app", "/v1/auth/setup", {
        method: "POST",
        json: { token, email: "eve@example.com", password: PASSWORD },
      })
    ).status,
  ).toBe(404);
  expect((await second.call("app", "/v1/previews", { headers: { cookie } })).status).toBe(200);
  expect(
    (
      await second.call("app", "/v1/auth/login", {
        method: "POST",
        json: { email: "ada@example.com", password: PASSWORD },
      })
    ).status,
  ).toBe(200);
}, 30_000);

test("a restart before setup mints a new link and kills the old one", async () => {
  const dir = tempDir();
  const first = await start(dir);
  const oldToken = new URL(first.running.setupUrl!).searchParams.get("token")!;
  await first.stop();

  const second = await start(dir);
  expect(second.running.setupUrl).not.toBeNull();
  expect(second.running.setupUrl).not.toContain(oldToken);
  expect(
    (
      await second.call("app", "/v1/auth/setup", {
        method: "POST",
        json: { token: oldToken, email: "ada@example.com", password: PASSWORD },
      })
    ).status,
  ).toBe(403);
}, 30_000);

test("with the UI off no setup link is printed and the env token is the way in", async () => {
  const dir = tempDir();
  const r = await start(dir, { GANGWAY_SURFACE_UI: "false" });
  expect(r.running.setupUrl).toBeNull();
  expect(r.announced.join("\n")).not.toContain("gw_setup_");
  expect(
    (await r.call("api", "/v1/previews", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }))
      .status,
  ).toBe(200);
}, 30_000);
