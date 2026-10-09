/**
 * Three orgs on one real boot for the tenancy contract: the home org, "bee" holding one of every
 * org-scoped thing, and "aye" holding next to nothing. Each org acts through its own admin token.
 */
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { join } from "node:path";
import type { Running } from "../../src/boot.ts";
import { API, setupAdmin, WHOAMI } from "./boot-e2e.ts";
import { tempDir } from "./db.ts";
import { bootWithFakeDaemon, client } from "./fake-daemon.ts";
import { freePort } from "./free-port.ts";
import { tarball } from "./runtimes-fixtures.ts";

export type Call = (path: string, init?: RequestInit) => Promise<Response>;

/** What an org holds, by the name a route's path parameter uses for it. */
export type Holdings = {
  previews: string[];
  /** Its private container preview's hostname, for the auth gate. */
  privateHost: string | null;
  project: { id: string; slug: string; repository: string } | null;
  token: string | null;
  domain: { id: string; name: string } | null;
  template: string | null;
  theme: string | null;
  artifactTemplate: string | null;
  grant: string | null;
  user: string | null;
};

export type Org = {
  id: string;
  slug: string;
  home: boolean;
  as: Call;
  /** Its bearer secret, for MCP. */
  secret: string;
  holds: Holdings;
  /** Text only this org's answers may carry: ids, names and secret values. */
  markers: string[];
};

export type World = { running: Running; dir: string; orgs: { home: Org; aye: Org; bee: Org } };

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const read = async <T>(res: Response, status: number): Promise<T> => {
  const text = await res.text();
  expect({ status: res.status, text }).toEqual({ status, text });
  return JSON.parse(text) as T;
};

const EMPTY: Holdings = {
  previews: [],
  privateHost: null,
  project: null,
  token: null,
  domain: null,
  template: null,
  theme: null,
  artifactTemplate: null,
  grant: null,
  user: null,
};

export async function bootWorld(): Promise<World> {
  const dir = tempDir();
  const running = await bootWithFakeDaemon(dir, { from: await freePort(), count: 8 });
  const admin = client(running);
  const homeCall: Call = (path, init) => admin(API, path, init);
  expect((await homeCall("/v1/surfaces", json("PUT", { mcp: true }))).status).toBe(200);
  const home: Org = {
    id: "00000000000000000000000000",
    slug: "default",
    home: true,
    as: homeCall,
    secret: running.adminToken,
    holds: { ...EMPTY },
    markers: [],
  };
  const aye = await makeOrg(running, dir, homeCall, "aye");
  const bee = await makeOrg(running, dir, homeCall, "bee");
  await seedOrg(running, dir, bee, homeCall);
  await seedHome(running, dir, home, homeCall);
  return { running, dir, orgs: { home, aye, bee } };
}

function bearer(running: Running, secret: string): Call {
  const admin = client(running);
  return (path, init) =>
    admin(API, path, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        authorization: `Bearer ${secret}`,
      },
    });
}

// No way in yet for a person of another org, so an ownerless token is minted and moved there.
async function mint(
  dir: string,
  homeCall: Call,
  orgId: string,
  wanted: { name: string; scopes: string[] },
) {
  const { token, secret } = await read<{ token: { id: string }; secret: string }>(
    await homeCall("/v1/tokens", json("POST", wanted)),
    201,
  );
  const db = new Database(join(dir, "gangway.db"));
  db.query("UPDATE api_tokens SET org_id = ? WHERE id = ?").run(orgId, token.id);
  db.query("UPDATE audit SET org_id = ? WHERE target = ?").run(orgId, token.id);
  db.close();
  return { id: token.id, secret };
}

async function makeOrg(running: Running, dir: string, homeCall: Call, slug: string) {
  const { org } = await read<{ org: { id: string } }>(
    await homeCall("/v1/operator/orgs", json("POST", { slug, name: slug.toUpperCase() })),
    201,
  );
  const minted = await mint(dir, homeCall, org.id, { name: `${slug}-admin`, scopes: ["admin"] });
  const o: Org = {
    id: org.id,
    slug,
    home: false,
    as: bearer(running, minted.secret),
    secret: minted.secret,
    holds: { ...EMPTY },
    markers: [],
  };
  return o;
}

type Preview = { preview: { id: string; name: string; urls: { url: string }[] } };

async function staticSite(o: Org, name: string) {
  const res = await o.as(
    `/v1/previews?wait=true&runtime=auto&visibility=public&name=${name}&ttl=30d`,
    {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body: await tarball({ "index.html": `<h1>${name}</h1>` }),
    },
  );
  return (await read<Preview>(res, 201)).preview;
}

/** bee: a private container preview with secrets, a static site, a project, a token, a domain. */
async function seedOrg(_running: Running, dir: string, o: Org, homeCall: Call) {
  // First, so the container takes the one port freePort checked; sites only hold theirs.
  const app = await read<Preview>(
    await o.as(
      "/v1/previews?wait=true",
      json("POST", { name: `${o.slug}app`, visibility: "private", source: WHOAMI }),
    ),
    201,
  );
  const site = await staticSite(o, `${o.slug}site`);
  await read(
    await o.as(
      `/v1/previews/${app.preview.id}/env`,
      json("PATCH", { set: { PREVIEW_SECRET: `${o.slug}-preview-secret` } }),
    ),
    200,
  );
  await seedCommon(dir, o, homeCall);
  o.holds.previews = [app.preview.id, site.id];
  o.holds.privateHost = new URL(app.preview.urls[0]!.url).hostname;
  o.holds.template = `d${o.id.toLowerCase()}`;
  o.markers.push(app.preview.id, site.id, `${o.slug}app`, `${o.slug}site`);
}

/** The home org: a static site and what only it may make, as well as the common holdings. */
async function seedHome(running: Running, dir: string, o: Org, homeCall: Call) {
  const site = await staticSite(o, "homesite");
  await seedCommon(dir, o, homeCall);
  const theme = await o.as(
    "/v1/artifact-themes",
    json("POST", { id: "hometheme", name: "Home theme", tokens: { light: {}, dark: {} } }),
  );
  await read(theme, 201);
  await read(
    await o.as("/v1/secrets", json("PATCH", { set: { HOME_SECRET: "home-global" } })),
    200,
  );
  await read(await o.as("/v1/templates", json("POST", { id: "hometpl", name: "Home" })), 201);
  const setup = await setupAdmin(running);
  expect(setup.status).toBe(201);
  const db = new Database(join(dir, "gangway.db"));
  const user = db.query("SELECT id FROM users LIMIT 1").get() as { id: string };
  db.close();
  o.holds = { ...o.holds, previews: [site.id], template: "hometpl", theme: "hometheme" };
  o.holds.user = user.id;
  o.markers.push(site.id, "homesite", "home-global", "ada@example.com");
}

async function seedCommon(dir: string, o: Org, homeCall: Call) {
  const repository = `${o.slug}-owner/${o.slug}-repo`;
  const { project } = await read<{ project: { id: string; slug: string } }>(
    await o.as("/v1/projects", json("POST", { name: `${o.slug}-web`, repository })),
    201,
  );
  await read(
    await o.as(
      `/v1/projects/${project.slug}/env`,
      json("PATCH", { set: { PROJECT_SECRET: `${o.slug}-project-secret` } }),
    ),
    200,
  );
  const token = await mint(dir, homeCall, o.id, { name: `${o.slug}-extra`, scopes: ["read"] });
  const { domain } = await read<{ domain: { id: string; name: string } }>(
    await o.as("/v1/domains", json("POST", { name: `${o.slug}.example.com`, kind: "wildcard" })),
    201,
  );
  o.holds = {
    ...o.holds,
    project: { ...project, repository },
    token: token.id,
    domain,
    grant: seedGrant(dir, o),
  };
  o.markers.push(
    project.id,
    `${o.slug}-web`,
    repository,
    `${o.slug}-project-secret`,
    `${o.slug}-preview-secret`,
    token.id,
    `${o.slug}-extra`,
    domain.id,
    domain.name,
    `${o.slug}-grant`,
  );
}

// A grant belongs to a person; the first user is made later, so this one is ownerless in effect.
function seedGrant(dir: string, o: Org): string {
  const db = new Database(join(dir, "gangway.db"));
  db.run("PRAGMA foreign_keys = OFF");
  const id = `${o.slug}-grant`;
  db.query(
    `INSERT INTO oauth_grants (id, user_id, client_id, client_name, redirect_uri, resource,
       access_hash, access_expires_at, refresh_hash, refresh_expires_at, absolute_expires_at,
       created_at, org_id)
     VALUES (?, 'nobody', 'c', 'Client', 'https://x.example/cb', 'r', ?, 9e15, ?, 9e15, 9e15, 0, ?)`,
  ).run(id, `${id}-a`, `${id}-r`, o.id);
  db.close();
  return id;
}

const ORG_TABLES = [
  "previews",
  "projects",
  "templates",
  "artifact_themes",
  "artifact_templates",
  "domains",
  "api_tokens",
  "oauth_grants",
  "roles",
  "memberships",
];

// What a reconciler pass or a credential's own use may move; nothing an attacker could.
const VOLATILE = /^(last_|updated_at$|state_changed_at$|reconciled|seen_at$)/;

/** Every row an org owns, minus the columns that move on their own; plus its audit and events. */
export function snapshot(dir: string, org: Org): string {
  const db = new Database(join(dir, "gangway.db"), { readonly: true });
  const out: Record<string, unknown> = {};
  for (const table of ORG_TABLES) {
    const rows = db.query(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY rowid`).all(org.id);
    out[table] = (rows as Record<string, unknown>[]).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.test(k))),
    );
  }
  const ids = org.holds.previews;
  const marks = ids.map(() => "?").join(",");
  out["routes"] = db.query(`SELECT * FROM routes WHERE preview_id IN (${marks})`).all(...ids);
  out["secrets"] = db.query("SELECT * FROM settings WHERE key LIKE 'secrets%'").all();
  for (const t of ["audit", "events"]) {
    out[t] = db.query(`SELECT count(*) AS n FROM ${t} WHERE org_id = ?`).get(org.id);
  }
  db.close();
  return JSON.stringify(out, null, 1);
}

/** The markers of `victim` found in `text`, which `viewer` may not see. */
export function leaked(text: string, victim: Org): string[] {
  return victim.markers.filter((m) => text.includes(m));
}
