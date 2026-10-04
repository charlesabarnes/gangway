import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { API, WHOAMI } from "../helpers/boot-e2e.ts";
import { tempDir } from "../helpers/db.ts";
import { bootWithFakeDaemon, client } from "../helpers/fake-daemon.ts";
import { freePort } from "../helpers/free-port.ts";

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
  const made = await home("/v1/operator/orgs", post({ slug: "other", name: "Other" }));
  expect(made.status).toBe(201);
  const otherId = ((await made.json()) as { org: { id: string } }).org.id;
  // No way in yet for a person of another org, so an ownerless token is moved there.
  const minted = await home("/v1/tokens", post({ name: "other-org", scopes: ["admin"] }));
  const { secret } = (await minted.json()) as { secret: string };
  const db = new Database(join(dir, "gangway.db"));
  db.query("UPDATE api_tokens SET org_id = ? WHERE name = 'other-org'").run(otherId);
  db.close();
  const other = (path: string, init?: RequestInit) =>
    admin(API, path, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${secret}` },
    });
  return { home, other, otherId };
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
  const { home, other, otherId } = await twoOrgs();
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
  expect(theirs.orgId).toBe(otherId);
  expect(await ids(await home("/v1/previews"))).not.toContain(theirs.id);
  expect((await home(`/v1/previews/${theirs.id}`)).status).toBe(404);
});

test("tokens, audit entries and domains stay with their org", async () => {
  const { home, other } = await twoOrgs();
  const claimed = await home(
    "/v1/domains",
    post({ name: "previews.example.com", kind: "wildcard" }),
  );
  expect(claimed.status).toBe(201);
  const { domain } = (await claimed.json()) as { domain: { id: string } };

  const tokens = (await (await other("/v1/tokens?all=true")).json()) as {
    tokens: { name: string }[];
  };
  expect(tokens.tokens.map((t) => t.name)).toEqual(["other-org"]);
  const audit = (await (await other("/v1/audit")).json()) as { entries: { action: string }[] };
  expect(audit.entries.map((e) => e.action)).not.toContain("domain.claimed");
  const domains = (await (await other("/v1/domains")).json()) as {
    available: string[];
    domains: { id: string }[];
  };
  expect(domains.domains).toEqual([]);
  expect(domains.available).not.toContain("previews.example.com");
  expect((await other(`/v1/domains/${domain.id}`, { method: "DELETE" })).status).toBe(404);
  const again = await other(
    "/v1/domains",
    post({ name: "previews.example.com", kind: "wildcard" }),
  );
  expect(again.status).toBe(409);

  const own = (await (await home("/v1/audit")).json()) as { entries: { action: string }[] };
  expect(own.entries.map((e) => e.action)).toContain("domain.claimed");
});

test("another org holds nothing that acts on the whole server", async () => {
  const { home, other } = await twoOrgs();
  const patch = (body: unknown): RequestInit => ({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect((await home("/v1/secrets", patch({ set: { HOME_ONLY: "1" } }))).status).toBe(200);
  for (const path of ["/v1/settings", "/v1/hosts", "/v1/users", "/v1/roles"]) {
    expect({ path, status: (await other(path)).status }).toEqual({ path, status: 403 });
    expect({ path, status: (await home(path)).status }).toEqual({ path, status: 200 });
  }
  const secrets = (await (await other("/v1/secrets")).json()) as { secrets: unknown };
  expect(JSON.stringify(secrets)).not.toContain("HOME_ONLY");
  expect((await other("/v1/secrets", patch({ set: { THEIRS: "1" } }))).status).toBe(403);
});

test("a new org gets its own default template, and only the home org makes orgs", async () => {
  const { home, other, otherId } = await twoOrgs();
  expect((await home("/v1/operator/orgs", post({ slug: "other", name: "Again" }))).status).toBe(
    409,
  );
  expect((await home("/v1/operator/orgs", post({ slug: "a-b", name: "Bad" }))).status).toBe(422);
  expect((await other("/v1/operator/orgs", post({ slug: "third", name: "Third" }))).status).toBe(
    403,
  );
  const listed = (await (await home("/v1/operator/orgs")).json()) as { orgs: { slug: string }[] };
  expect(listed.orgs.map((o) => o.slug)).toEqual(["default", "other"]);

  type Templates = { templates: { id: string; builtin: boolean }[] };
  const theirs = (await (await other("/v1/templates")).json()) as Templates;
  const ours = (await (await home("/v1/templates")).json()) as Templates;
  expect(theirs.templates.map((t) => [t.id, t.builtin])).toEqual([
    [`d${otherId.toLowerCase()}`, true],
  ]);
  expect(ours.templates.map((t) => t.id)).toEqual(["default"]);
});

test("another org's previews end in --slug; the home org's names stay as they were", async () => {
  const { home, other } = await twoOrgs();
  type Made = { preview: { id: string; urls: { url: string }[] } };
  const hostOf = async (res: Response) => {
    expect(res.status).toBe(201);
    const { preview } = (await res.json()) as Made;
    return { id: preview.id, host: new URL(preview.urls[0]!.url).hostname };
  };
  const body = post({ name: "site", visibility: "public", source: WHOAMI });
  const mine = await hostOf(await home("/v1/previews?wait=true", body));
  expect(mine.host.split(".")[0]).toBe("site");
  // The fake host has one upstream port.
  expect((await home(`/v1/previews/${mine.id}`, { method: "DELETE" })).status).toBe(200);
  const theirs = await hostOf(await other("/v1/previews?wait=true", body));
  expect(theirs.host.split(".")[0]).toBe("site--other");
});
