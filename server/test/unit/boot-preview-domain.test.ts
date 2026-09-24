import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect } from "node:tls";
import { boot } from "../../src/boot.ts";
import { loadConfig } from "../../src/config.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { Logger } from "../../src/logger.ts";
import { onCleanup } from "../helpers/cleanup.ts";
import { tempDir } from "../helpers/db.ts";
import { freePort } from "../helpers/free-port.ts";

const CONTROL = "gw.localhost";
const PREVIEWS = "previews.localhost";

async function start(env: Record<string, string>) {
  const config = loadConfig(
    {
      GANGWAY_STATE_DIR: tempDir(),
      GANGWAY_LISTEN_ADDRESS: "127.0.0.1",
      GANGWAY_LISTEN_PORT: String(await freePort()),
      GANGWAY_LISTEN_HTTP_PORT: "",
      GANGWAY_ADMIN_TOKEN: "gw_boot_preview_domain_0123456789abcd",
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
    announce: () => {},
    logger: new Logger("error", {}, () => {}),
  });
  onCleanup(() => running.stop());
  return running;
}

function handshake(port: number, servername: string, ca: string) {
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, servername, ca, rejectUnauthorized: false });
    socket.once("secureConnect", () => {
      resolve(socket.authorized);
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

test("one certificate covers the control and the preview domain", async () => {
  const running = await start({ GANGWAY_BASE_DOMAIN: CONTROL, GANGWAY_PREVIEW_DOMAIN: PREVIEWS });
  const ca = readFileSync(running.caPath!, "utf8");
  const port = running.listener.port;
  for (const name of [`app.${CONTROL}`, CONTROL, `acme.${PREVIEWS}`, PREVIEWS])
    expect(await handshake(port, name, ca)).toBe(true);
});

test("the UI answers on the control domain and not on the preview domain", async () => {
  const running = await start({ GANGWAY_BASE_DOMAIN: CONTROL, GANGWAY_PREVIEW_DOMAIN: PREVIEWS });
  const call = (host: string) =>
    fetch(`https://127.0.0.1:${running.listener.port}/v1/auth/session`, {
      headers: { host },
      tls: { rejectUnauthorized: false },
    } as RequestInit);
  expect((await call(`app.${CONTROL}`)).status).toBe(200);
  expect((await call(`app.${PREVIEWS}`)).status).toBe(404);
});

test("a control domain nested under the preview domain is refused at boot", async () => {
  expect(
    start({ GANGWAY_BASE_DOMAIN: `gw.${PREVIEWS}`, GANGWAY_PREVIEW_DOMAIN: PREVIEWS }),
  ).rejects.toThrow(/control domain/);
});
