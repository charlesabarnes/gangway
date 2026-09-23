/**
 * tls/acme.ts against a REAL ACME server: Pebble (Let's Encrypt's test CA) plus its
 * challenge DNS server, both on a Docker host reachable over SSH as $DOCKER_HOST_SSH. The
 * unit test proves the sequencing against a fake; this proves the protocol -- nonces, JWS, order finalization, a real chain -- and
 * then the part no unit test can: gangway boots on the dev CA, the `cert-renew` job
 * obtains the certificate, and the LISTENER starts presenting it without a restart.
 *
 *   ssh $DOCKER_HOST_SSH 'docker run --rm -d --name gw-acme-challtestsrv \
 *       -p 127.0.0.1:31900:14000 -p 127.0.0.1:31901:8055 ghcr.io/letsencrypt/pebble-challtestsrv:latest \
 *       -http01 "" -https01 "" -tlsalpn01 "" -doh "" -dnsserver ":8053" -management ":8055"'
 *   ssh $DOCKER_HOST_SSH 'docker run --rm -d --name gw-acme-pebble --network container:gw-acme-challtestsrv \
 *       -e PEBBLE_VA_NOSLEEP=1 ghcr.io/letsencrypt/pebble:latest \
 *       -config test/config/pebble-config.json -dnsserver 127.0.0.1:8053 -strict'
 *   ssh -N -L 31900:127.0.0.1:31900 -L 31901:127.0.0.1:31901 $DOCKER_HOST_SSH &
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/acme-pebble-check.ts
 *   ssh $DOCKER_HOST_SSH 'docker stop gw-acme-pebble gw-acme-challtestsrv'
 *
 * Pebble's own API certificate comes from a throwaway CA, hence NODE_TLS_REJECT_UNAUTHORIZED
 * -- for this script only. Pebble deliberately rejects ~5% of nonces, so a pass here also
 * exercises the badNonce retry path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { boot } from "../server/src/boot.ts";
import { loadConfig } from "../server/src/config.ts";
import { Logger } from "../server/src/logger.ts";
import type { DnsProvider } from "../server/src/tls/dns/provider.ts";

const DIRECTORY = process.env["PEBBLE_DIRECTORY"] ?? "https://localhost:31900/dir";
const CHALLTESTSRV = process.env["PEBBLE_CHALLTESTSRV"] ?? "http://localhost:31901";
const BASE = "preview.gangway.test";

const seen: string[] = [];
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${CHALLTESTSRV}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`challtestsrv ${path}: ${res.status}`);
};
const dns: DnsProvider = {
  async createTxt(name, value) {
    seen.push(value);
    await post("/set-txt", { host: `${name}.`, value });
    return { recordId: name };
  },
  async removeTxt(_id, name) {
    await post("/clear-txt", { host: `${name}.` });
  },
  async waitForPropagation() {
    return true;
  },
};

/** What the listener presents RIGHT NOW for this SNI name. */
const presented = (port: number, servername: string) =>
  new Promise<{ issuer: string; sans: string }>((resolve, reject) => {
    const s = tlsConnect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve({ issuer: String(c.issuer?.CN ?? ""), sans: String(c.subjectaltname ?? "") });
    });
    s.on("error", reject);
  });

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
};

const freePort = (): number => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = s;
  s.stop(true);
  return port;
};

const stateDir = mkdtempSync(join(tmpdir(), "gangway-pebble-"));
const lines: string[] = [];
const start = async () => {
  const config = loadConfig(
    {
      GANGWAY_STATE_DIR: stateDir,
      GANGWAY_LISTEN_ADDRESS: "127.0.0.1",
      GANGWAY_LISTEN_PORT: String(freePort()),
      GANGWAY_LISTEN_HTTP_PORT: "",
      GANGWAY_ADMIN_TOKEN: "gw_pebble_check_0123456789abcdef",
      GANGWAY_TLS_MODE: "acme",
      GANGWAY_RECONCILE_INTERVAL_MS: "0",
      GANGWAY_BASE_DOMAIN: BASE,
      GANGWAY_ACME_DIRECTORY_URL: DIRECTORY,
    },
    {},
  );
  return boot(config, {
    acme: { dns },
    logger: new Logger("info", {}, (l) => lines.push(l)),
    // No Docker in this check, and above all not whatever socket this machine has.
    clients: {
      for: () => ({
        hostId: "local",
        info: async () => {
          throw new Error("no docker in the pebble check");
        },
        listContainers: async () => [],
        stopContainer: async () => {},
      }),
    },
  });
};

try {
  let running = await start();
  const port = running.listener.port;
  const first = await presented(port, `hello.${BASE}`);
  check(
    "boots serving the dev CA while the first order runs",
    first.issuer.includes("gangway"),
    first.issuer,
  );

  await running.scheduler.trigger("cert-renew"); // joins the run boot already started
  const swapped = await presented(port, `hello.${BASE}`);
  check(
    "the listener presents the ACME certificate WITHOUT a restart",
    swapped.issuer.includes("Pebble"),
    swapped.issuer,
  );
  check(
    "it covers the wildcard and the apex",
    swapped.sans.includes(`DNS:*.${BASE}`) && swapped.sans.includes(`DNS:${BASE}`),
    swapped.sans,
  );
  check(
    "two DIFFERENT TXT values were published for the one order",
    new Set(seen).size === 2,
    `${seen.length} values`,
  );
  check(
    "the API surface still answers on the new certificate",
    (
      await fetch(`https://127.0.0.1:${port}/healthz`, {
        headers: { host: `api.${BASE}` },
        tls: { rejectUnauthorized: false },
      } as RequestInit)
    ).status === 200,
  );
  await running.stop();

  const orders = seen.length;
  running = await start();
  const restarted = await presented(running.listener.port, `hello.${BASE}`);
  await running.scheduler.trigger("cert-renew");
  check(
    "after a restart the stored certificate is served immediately",
    restarted.issuer.includes("Pebble"),
    restarted.issuer,
  );
  check(
    "...and NO new order is placed",
    seen.length === orders,
    `${seen.length - orders} new TXT records`,
  );
  if (process.exitCode)
    console.error(lines.filter((l) => l.includes("acme") || l.includes("tls")).join("\n"));
  await running.stop();
} catch (e) {
  console.error(e);
  console.error(lines.slice(-15).join("\n"));
  process.exitCode = 1;
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
