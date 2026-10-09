import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { API, WHOAMI } from "../helpers/boot-e2e.ts";
import { tempDir } from "../helpers/db.ts";
import { bootWithFakeDaemon, client } from "../helpers/fake-daemon.ts";
import { freePort } from "../helpers/free-port.ts";

type Call = (path: string, init?: RequestInit) => Promise<Response>;

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function twoOrgs(dir = tempDir()) {
  const running = await bootWithFakeDaemon(dir, await freePort());
  const admin = client(running);
  const home: Call = (path, init) => admin(API, path, init);
  const made = await home("/v1/operator/orgs", send("POST", { slug: "other", name: "Other" }));
  expect(made.status).toBe(201);
  const otherId = ((await made.json()) as { org: { id: string } }).org.id;
  const minted = await home("/v1/tokens", send("POST", { name: "other-org", scopes: ["admin"] }));
  const { secret } = (await minted.json()) as { secret: string };
  const db = new Database(join(dir, "gangway.db"));
  db.query("UPDATE api_tokens SET org_id = ? WHERE name = 'other-org'").run(otherId);
  db.close();
  const other: Call = (path, init) =>
    admin(API, path, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${secret}` },
    });
  const visit = (host: string) => admin(host, "/");
  return { running, dir, home, other, otherId, visit };
}

async function deploy(as: Call, name: string) {
  const res = await as(
    "/v1/previews?wait=true",
    send("POST", { name, visibility: "public", source: WHOAMI }),
  );
  expect(res.status).toBe(201);
  const { preview } = (await res.json()) as { preview: { id: string; urls: { url: string }[] } };
  return { id: preview.id, host: new URL(preview.urls[0]!.url).hostname };
}

test("a suspended org's previews answer 410 and stay unchanged until resumed", async () => {
  const { home, other, otherId, visit } = await twoOrgs();
  const site = await deploy(other, "site");
  expect((await visit(site.host)).status).toBe(200);

  const res = await home(`/v1/operator/orgs/${otherId}/suspend`, send("POST", { reason: "spam" }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { org: { state: string }; slept: string[] };
  expect(body.org.state).toBe("suspended");
  expect(body.slept).toEqual([site.id]);

  expect((await visit(site.host)).status).toBe(410);
  const again = await other(
    "/v1/previews?wait=true",
    send("POST", { name: "more", visibility: "public", source: WHOAMI }),
  );
  expect(again.status).toBe(403);
  expect((await other(`/v1/previews/${site.id}/ttl`, send("PUT", { extend: "7d" }))).status).toBe(
    403,
  );
  // Members still read what they have.
  expect((await other(`/v1/previews/${site.id}`)).status).toBe(200);

  const audit = (await (await home("/v1/audit?limit=10")).json()) as {
    entries: { action: string; target: string }[];
  };
  expect(audit.entries.map((e) => e.action)).toContain("org.suspended");

  const resumed = await home(`/v1/operator/orgs/${otherId}/resume`, send("POST"));
  expect(((await resumed.json()) as { org: { state: string } }).org.state).toBe("active");
  expect((await visit(site.host)).status).toBe(200);
});

test("the home org cannot be suspended, and nobody outside it may suspend", async () => {
  const { home, other, otherId } = await twoOrgs();
  const orgs = (await (await home("/v1/operator/orgs")).json()) as {
    orgs: { id: string; home: boolean }[];
  };
  const homeId = orgs.orgs.find((o) => o.home)!.id;
  const reason = send("POST", { reason: "test" });
  expect((await home(`/v1/operator/orgs/${homeId}/suspend`, reason)).status).toBe(409);
  expect((await home("/v1/operator/orgs/nope/suspend", reason)).status).toBe(404);
  expect((await home(`/v1/operator/orgs/${otherId}/suspend`, send("POST", {}))).status).toBe(422);
  expect((await other(`/v1/operator/orgs/${otherId}/suspend`, reason)).status).toBe(403);
});

test("suspension outlives a restart", async () => {
  const dir = tempDir();
  const first = await twoOrgs(dir);
  const site = await deploy(first.other, "site");
  await first.home(`/v1/operator/orgs/${first.otherId}/suspend`, send("POST", { reason: "x" }));
  await first.running.stop();

  const running = await bootWithFakeDaemon(dir, await freePort());
  const admin = client(running);
  expect((await admin(site.host, "/")).status).toBe(410);
});

test("a taken-down preview is destroyed and its hostname answers 410 until lifted", async () => {
  const { home, other, visit } = await twoOrgs();
  const site = await deploy(other, "site");

  const res = await home(
    `/v1/operator/previews/${site.id}/takedown`,
    send("POST", { reason: "phishing" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { destroyed: boolean; takedowns: { hostname: string }[] };
  expect(body.destroyed).toBe(true);
  expect(body.takedowns.map((t) => t.hostname)).toEqual([site.host]);
  expect((await visit(site.host)).status).toBe(410);
  expect((await other(`/v1/previews/${site.id}`)).status).toBe(200);

  // The same name deployed again stays dark.
  await deploy(other, "site");
  expect((await visit(site.host)).status).toBe(410);

  const listed = (await (await home("/v1/operator/takedowns")).json()) as {
    takedowns: { hostname: string; reason: string }[];
  };
  expect(listed.takedowns).toMatchObject([{ hostname: site.host, reason: "phishing" }]);
  expect((await other("/v1/operator/takedowns")).status).toBe(403);

  const lifted = await home(`/v1/operator/takedowns/${site.host}`, send("DELETE"));
  expect(lifted.status).toBe(200);
  expect((await visit(site.host)).status).toBe(200);
  expect((await home(`/v1/operator/takedowns/${site.host}`, send("DELETE"))).status).toBe(404);
  expect(
    (await home("/v1/operator/previews/nope/takedown", send("POST", { reason: "x" }))).status,
  ).toBe(404);
});

test("changedSince lists the orgs whose people or state changed, with how many people", async () => {
  const { home, otherId, dir } = await twoOrgs();
  type Seats = { orgs: { id: string; members: number }[] };
  const all = (await (await home("/v1/operator/orgs")).json()) as Seats;
  expect(all.orgs.find((o) => o.id === otherId)?.members).toBe(0);

  const since = Date.now();
  await Bun.sleep(5);
  const none = (await (await home(`/v1/operator/orgs?changedSince=${since}`)).json()) as Seats;
  expect(none.orgs).toEqual([]);

  const db = new Database(join(dir, "gangway.db"));
  const role = db
    .query("SELECT id FROM roles WHERE org_id = ? AND kind = 'member'")
    .get(otherId) as {
    id: string;
  };
  db.run(
    "INSERT INTO users (id, email, password_hash, password_salt, role_id, created_at) VALUES ('u9', 'ann@example.com', 'h', 's', 'viewer', 1)",
  );
  db.query(
    "INSERT INTO memberships (org_id, user_id, role_id, created_at) VALUES (?, 'u9', ?, 1)",
  ).run(otherId, role.id);
  db.close();
  const changed = (await (await home(`/v1/operator/orgs?changedSince=${since}`)).json()) as Seats;
  expect(changed.orgs.map((o) => [o.id, o.members])).toEqual([[otherId, 1]]);

  expect((await home("/v1/operator/orgs?changedSince=soon")).status).toBe(400);
});
