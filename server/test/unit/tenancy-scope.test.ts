import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { API, WHOAMI } from "../helpers/boot-e2e.ts";
import { tempDir } from "../helpers/db.ts";
import { bootWithFakeDaemon, client } from "../helpers/fake-daemon.ts";
import { freePort } from "../helpers/free-port.ts";

const OTHER = "01JORG0THER00000000000000A";

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function twoOrgs() {
  const dir = tempDir();
  const running = await bootWithFakeDaemon(dir, await freePort());
  const admin = client(running);
  const home = (path: string, init?: RequestInit) => admin(API, path, init);
  const minted = await home("/v1/tokens", post({ name: "other-org", scopes: ["admin"] }));
  const { secret } = (await minted.json()) as { secret: string };
  const db = new Database(join(dir, "gangway.db"));
  db.run(
    `INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ('${OTHER}', 'other', 'Other', 1, 1)`,
  );
  db.run(`UPDATE api_tokens SET org_id = '${OTHER}' WHERE name = 'other-org'`);
  db.close();
  const other = (path: string, init?: RequestInit) =>
    admin(API, path, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${secret}` },
    });
  return { home, other };
}

const deploy = async (as: (p: string, i?: RequestInit) => Promise<Response>, name: string) => {
  const res = await as(
    "/v1/previews?wait=true",
    post({ name, visibility: "public", source: WHOAMI }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { preview: { id: string; orgId: string } }).preview;
};

const ids = async (res: Response) =>
  ((await res.json()) as { previews: { id: string }[] }).previews.map((p) => p.id);

test("an org cannot list, read or destroy another org's previews or projects", async () => {
  const { home, other } = await twoOrgs();
  const mine = await deploy(home, "home-site");
  expect((await home("/v1/projects", post({ name: "home-web" }))).status).toBe(201);

  expect(await ids(await other("/v1/previews"))).not.toContain(mine.id);
  expect((await other(`/v1/previews/${mine.id}`)).status).toBe(404);
  expect((await other(`/v1/previews/${mine.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await other(`/v1/previews/${mine.id}/events`)).status).toBe(404);
  expect((await other("/v1/projects/home-web")).status).toBe(404);
  expect(
    ((await (await other("/v1/projects")).json()) as { projects: unknown[] }).projects,
  ).toEqual([]);
  expect((await home(`/v1/previews/${mine.id}`)).status).toBe(200);
  // The fake host has one upstream port.
  expect((await home(`/v1/previews/${mine.id}`, { method: "DELETE" })).status).toBe(200);

  const theirs = await deploy(other, "other-site");
  expect(theirs.orgId).toBe(OTHER);
  expect(await ids(await home("/v1/previews"))).not.toContain(theirs.id);
  expect((await home(`/v1/previews/${theirs.id}`)).status).toBe(404);
});
