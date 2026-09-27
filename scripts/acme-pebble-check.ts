// How to run this: scripts/README.md
import { Database } from "bun:sqlite";
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
const ALT = "alt.gangway.test";
const CUSTOMER = "customer.test";
const CLAIM = "pebblecheck";

const seen: string[] = [];
const names: string[] = [];
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${CHALLTESTSRV}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`challtestsrv ${path}: ${res.status}`);
};
const dns: DnsProvider = {
  async createTxt(name, value) {
    seen.push(value);
    names.push(name);
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
      GANGWAY_PREVIEW_DOMAINS: ALT,
      GANGWAY_ACME_DIRECTORY_URL: DIRECTORY,
    },
    {},
  );
  return boot(config, {
    acme: { dns },
    logger: new Logger("info", {}, (l) => lines.push(l)),
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

  await running.scheduler.trigger("cert-renew");
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
    "two DIFFERENT TXT values were published for each order",
    new Set(seen).size === 4 && names.filter((n) => n === `_acme-challenge.${BASE}`).length === 2,
    `${seen.length} values`,
  );
  const alt = await presented(port, `hello.${ALT}`);
  check(
    "a second domain gets its OWN certificate, chosen by SNI",
    alt.issuer.includes("Pebble") && alt.sans.includes(`DNS:*.${ALT}`) && !alt.sans.includes(BASE),
    alt.sans,
  );

  // A claim as the verify job leaves it: its _acme-challenge is a CNAME to gangway's zone.
  const db = new Database(join(stateDir, "gangway.db"));
  db.run(
    `INSERT INTO domains (id, name, kind, status, claim_id, routing_ok, created_at, updated_at)
     VALUES ('d1', '${CUSTOMER}', 'wildcard', 'active', '${CLAIM}', 1, 0, 0)`,
  );
  db.close();
  await post("/set-cname", {
    host: `_acme-challenge.${CUSTOMER}.`,
    target: `${CLAIM}.acme.${BASE}.`,
  });
  running.ctx.domains!.refresh();
  await running.scheduler.trigger("cert-renew");
  const customer = await presented(port, `shop.${CUSTOMER}`);
  check(
    "a claimed domain is proved at its delegate, and served by SNI",
    customer.issuer.includes("Pebble") && customer.sans.includes(`DNS:*.${CUSTOMER}`),
    `${customer.issuer} ${customer.sans}`,
  );
  check(
    "...its TXT records went to gangway's zone, not the customer's",
    names.includes(`${CLAIM}.acme.${BASE}`) && !names.includes(`_acme-challenge.${CUSTOMER}`),
    names.join(" "),
  );
  await post("/clear-cname", { host: `_acme-challenge.${CUSTOMER}.` });
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
