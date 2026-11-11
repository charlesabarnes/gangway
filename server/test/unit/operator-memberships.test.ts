import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { API } from "../helpers/boot-e2e.ts";
import { tempDir } from "../helpers/db.ts";
import { bootWithFakeDaemon, client } from "../helpers/fake-daemon.ts";
import { freePort } from "../helpers/free-port.ts";

const ISSUER = "https://id.example.com";

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const lookup = (issuer: string, subject: string) =>
  `/v1/operator/memberships?issuer=${encodeURIComponent(issuer)}&subject=${subject}`;

test("the operator finds the orgs of the person behind a provider's subject", async () => {
  const dir = tempDir();
  const running = await bootWithFakeDaemon(dir, await freePort());
  const admin = client(running);
  const home = (path: string, init?: RequestInit) => admin(API, path, init);

  const added = await home(
    "/v1/users",
    post({ email: "bea@example.com", roleId: "member", password: "correct horse battery staple" }),
  );
  expect(added.status).toBe(201);
  const { user } = (await added.json()) as { user: { id: string } };
  const db = new Database(join(dir, "gangway.db"));
  db.query(
    "INSERT INTO user_identities (issuer, subject, user_id, created_at, last_used_at) VALUES (?, 'sub-bea', ?, 1, 1)",
  ).run(ISSUER, user.id);
  db.close();

  const found = await home(lookup(ISSUER, "sub-bea"));
  expect(found.status).toBe(200);
  expect(await found.json()).toMatchObject({
    user: user.id,
    memberships: [{ org: { slug: "default", home: true }, role: { id: "member", kind: "member" } }],
  });

  expect(await (await home(lookup(ISSUER, "sub-nobody"))).json()).toEqual({
    user: null,
    memberships: [],
  });
  expect(await (await home(lookup("https://other.example.com", "sub-bea"))).json()).toEqual({
    user: null,
    memberships: [],
  });
  expect((await home("/v1/operator/memberships?issuer=x")).status).toBe(400);
});

test("only the home org's operator may look a person up", async () => {
  const dir = tempDir();
  const running = await bootWithFakeDaemon(dir, await freePort());
  const admin = client(running);
  const home = (path: string, init?: RequestInit) => admin(API, path, init);
  const made = await home("/v1/operator/orgs", post({ slug: "other", name: "Other" }));
  const otherId = ((await made.json()) as { org: { id: string } }).org.id;
  const minted = await home("/v1/tokens", post({ name: "other-org", scopes: ["admin"] }));
  const { secret } = (await minted.json()) as { secret: string };
  const db = new Database(join(dir, "gangway.db"));
  db.query("UPDATE api_tokens SET org_id = ? WHERE name = 'other-org'").run(otherId);
  db.close();

  const res = await admin(API, lookup(ISSUER, "sub-bea"), {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(res.status).toBe(403);
});
