/**
 * Every route the app answers, and what one org may get from it about another. The contract test
 * fails on a route missing here, so a new route has to say which kind it is:
 *
 * - victim: names another org's thing in its path; 403 or 404, and nothing of theirs changes.
 * - list: the caller's own things; a 2xx carries nothing of another org's.
 * - stream: an event stream of the caller's own; read for a moment, it carries nothing else.
 * - own: makes or reads something of the caller's own; when the body names another org's thing
 *   (`refused`), it must not be a 2xx.
 * - instance: the server's own; another org gets 403, the home org may use it.
 * - operator: the home org's operator acting on orgs by id, by design.
 * - shared: the server's own catalogue, read by every org and changed only by the home org.
 * - public: before any credential; called with none, and it may carry nothing of an org's.
 * - middleware: not a route.
 */
import type { Org } from "./tenancy-world.ts";

export type Body = Record<string, unknown> | "tarball" | ((victim: Org) => Record<string, unknown>);

export type Rule =
  | { kind: "victim"; body?: Body; query?: string }
  | { kind: "list"; query?: string }
  | { kind: "stream" }
  | { kind: "own"; why: string; body?: Body; refused?: true }
  | { kind: "instance"; why: string; body?: Body }
  | { kind: "operator" }
  | { kind: "shared"; why: string; body?: Body }
  | { kind: "public"; why: string }
  | { kind: "middleware" };

const victim = (body?: Body, query?: string): Rule => ({
  kind: "victim",
  ...(body === undefined ? {} : { body }),
  ...(query === undefined ? {} : { query }),
});
const list = (query?: string): Rule => ({ kind: "list", ...(query ? { query } : {}) });
const own = (why: string, body?: Body, refused?: true): Rule => ({
  kind: "own",
  why,
  ...(body === undefined ? {} : { body }),
  ...(refused ? { refused } : {}),
});
const instance = (why: string, body?: Body): Rule => ({
  kind: "instance",
  why,
  ...(body === undefined ? {} : { body }),
});
const shared = (why: string, body?: Body): Rule => ({
  kind: "shared",
  why,
  ...(body === undefined ? {} : { body }),
});
const pub = (why: string): Rule => ({ kind: "public", why });

const SERVER = "the server's own configuration";
const CATALOGUE = "artifact themes and templates are one catalogue for the server, home-edited";
const SIGN_IN = "signing in comes before any org";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PROJECT_OF = (v: Org) => v.holds.project?.slug ?? "none";
const PREVIEW_OF = (v: Org) => v.holds.previews[0] ?? "none";

export const ROUTES: Record<string, Rule> = {
  "ALL /*": { kind: "middleware" },
  "ALL /v1/*": { kind: "middleware" },
  "GET /healthz": pub("liveness, the route count only"),
  "GET /.well-known/oauth-authorization-server": pub("OAuth metadata"),
  "GET /oauth/authorize": pub(SIGN_IN),
  "POST /oauth/register": pub(SIGN_IN),
  "POST /oauth/token": pub(SIGN_IN),
  "GET /v1/auth/session": pub(SIGN_IN),
  "POST /v1/auth/login": pub(SIGN_IN),
  "POST /v1/auth/setup": pub(SIGN_IN),
  "GET /v1/auth/gate": pub("checked on its own in the contract test"),
  "POST /v1/auth/password-reset": pub(SIGN_IN),
  "POST /v1/auth/link": pub(SIGN_IN),
  "POST /v1/auth/link/redeem": pub(SIGN_IN),
  "GET /v1/auth/oidc/start": pub(SIGN_IN),
  "GET /v1/auth/oidc/callback": pub(SIGN_IN),
  "POST /v1/auth/logout": pub(SIGN_IN),
  "POST /v1/auth/password": pub(SIGN_IN),
  "GET /v1/schema/gangway.yml": pub("the gangway.yml JSON schema"),

  "GET /v1/hosts": instance(SERVER),
  "GET /v1/events": { kind: "stream" },
  "POST /v1/previews": own(
    "a deploy into another org's project is refused",
    (v) => ({ project: PROJECT_OF(v), source: { kind: "image", image: "x/y:1", port: 80 } }),
    true,
  ),
  "GET /v1/previews": list("?all=true"),
  "GET /v1/previews/:id": victim(),
  "DELETE /v1/previews/:id": victim(),
  "GET /v1/previews/:id/events": victim(),
  "GET /v1/previews/:id/builds": victim(),
  "GET /v1/previews/:id/source": victim(),
  "GET /v1/previews/:id/plan": victim(),
  "PATCH /v1/previews/:id/source": victim({ files: { "index.html": "<h1>mine</h1>" } }),
  "PUT /v1/previews/:id/source": victim("tarball"),
  "PUT /v1/previews/:id/password": victim({ login: "on" }),
  "PUT /v1/previews/:id/title": victim({ title: "taken" }),
  "PUT /v1/previews/:id/watermark": victim({ watermark: "off" }),
  "PUT /v1/previews/:id/domain": victim({ domain: null }),
  "PUT /v1/previews/:id/ttl": victim({ extend: "none" }),
  "PUT /v1/previews/:id/icon": victim({ icon: null }),
  "GET /v1/previews/:id/share": victim(),
  "POST /v1/previews/:id/share": victim({}),
  "DELETE /v1/previews/:id/share": victim(),
  "GET /v1/previews/:id/logs": victim(),
  "GET /v1/runtimes": shared("the runtimes gangway knows"),
  "POST /v1/runtimes/plan": shared("a plan for the caller's own files", {
    paths: ["index.html"],
    files: {},
  }),
  "GET /v1/previews/:id/addons": victim(),
  "GET /v1/previews/:id/addons/:addon/tables": victim(),
  "GET /v1/previews/:id/addons/:addon/rows": victim(undefined, "?schema=public&table=t"),
  "GET /v1/previews/:id/addons/redis/keys": victim(),
  "GET /v1/previews/:id/addons/redis/key": victim(undefined, "?name=k"),
  "POST /v1/previews/:id/addons/:addon/query": victim({ text: "SELECT 1" }),
  "GET /v1/audit": list(),
  "GET /v1/tokens": list("?all=true"),
  "POST /v1/tokens": own("an API token cannot mint tokens", (v) => ({
    name: "x",
    scopes: ["secrets"],
    secretTargets: { previews: "own", projects: [PROJECT_OF(v)], org: false },
  })),
  "DELETE /v1/tokens/:id": victim(),
  "GET /v1/users": instance(SERVER),
  "POST /v1/users": instance(SERVER, { email: "x@example.com", roleId: "viewer" }),
  "PATCH /v1/users/:id": victim({ disabled: true }),
  "POST /v1/users/:id/email-link": victim({}),
  "GET /v1/roles": instance(SERVER),
  "PUT /v1/roles/:id/permissions": instance(SERVER, { permissions: [] }),
  "GET /v1/operator/orgs": { kind: "operator" },
  "POST /v1/operator/orgs": { kind: "operator" },
  "GET /v1/operator/orgs/:id": { kind: "operator" },
  "PUT /v1/operator/orgs/:id/limits": { kind: "operator" },
  "GET /v1/settings": instance(SERVER),
  "PUT /v1/settings": instance(SERVER, { values: {} }),
  "PUT /v1/settings/preview-password": instance(SERVER, { mode: "off" }),
  "POST /v1/settings/mail/test": instance(SERVER, { to: "x@example.com" }),
  "GET /v1/updates": instance(SERVER),
  "GET /v1/oauth/requests/:id": own("a pending consent of the caller's own, by its secret id"),
  "POST /v1/oauth/requests/:id": own("a pending consent of the caller's own, by its secret id", {
    approve: false,
  }),
  "GET /v1/oauth/grants": list(),
  "DELETE /v1/oauth/grants/:id": victim(),
  "GET /v1/capabilities": shared("what this server can do"),
  "GET /v1/surfaces": instance(SERVER),
  "PUT /v1/surfaces": instance(SERVER, { mcp: true }),
  "GET /v1/projects": list(),
  "GET /v1/projects/:ref": victim(),
  "POST /v1/projects": own(
    "a repository another org connected is refused",
    (v) => ({
      name: "mine",
      repository: v.holds.project?.repository ?? "none/none",
    }),
    true,
  ),
  "PATCH /v1/projects/:ref": victim({ name: "taken" }),
  "DELETE /v1/projects/:ref": victim(),
  "GET /v1/projects/:ref/env": victim(),
  "PATCH /v1/projects/:ref/env": victim({ set: { STOLEN: "1" } }),
  "GET /v1/projects/:ref/workflow": victim(),
  "PUT /v1/projects/:ref/branch": victim("tarball", `?sha=${SHA}`),
  "PUT /v1/projects/:ref/pulls/:n": victim({ image: "x/y:1", port: 80, sha: SHA }),
  "DELETE /v1/projects/:ref/pulls/:n": victim(),
  "GET /v1/templates": list(),
  "GET /v1/templates/:id": victim(),
  "POST /v1/templates": instance("templates are edited by the home org", { id: "x", name: "X" }),
  "PATCH /v1/templates/:id": victim({ name: "taken" }),
  "DELETE /v1/templates/:id": victim(),
  "GET /v1/artifacts": list(),
  "GET /v1/artifact-themes": shared(CATALOGUE),
  "GET /v1/artifact-themes/:id/theme.css": shared(CATALOGUE),
  "GET /v1/artifact-themes/:id/logo.svg": shared(CATALOGUE),
  "POST /v1/artifact-themes": instance(CATALOGUE, { id: "x", name: "X", tokens: {} }),
  "PUT /v1/artifact-themes/default": instance(CATALOGUE, { id: "chart" }),
  "PUT /v1/artifact-themes/:id": instance(CATALOGUE, { name: "taken" }),
  "DELETE /v1/artifact-themes/:id": instance(CATALOGUE),
  "GET /v1/artifact-templates": shared(CATALOGUE),
  "POST /v1/artifact-templates/render": shared(CATALOGUE, { template: "document/memo" }),
  "GET /v1/artifact-templates/:id{.+}": shared(CATALOGUE),
  "POST /v1/artifact-templates": instance(CATALOGUE, { id: "x/y" }),
  "PUT /v1/artifact-templates/:id{.+}": instance(CATALOGUE, { name: "taken" }),
  "DELETE /v1/artifact-templates/:id{.+}": instance(CATALOGUE),
  "POST /v1/artifacts": own(
    "an artifact rebuilt over another org's preview is refused",
    (v) => ({
      preview: PREVIEW_OF(v),
      artifact: { template: "document/memo", title: "x" },
    }),
    true,
  ),
  "GET /v1/domains": list(),
  "POST /v1/domains": own(
    "another org's domain cannot be claimed again",
    (v) => ({
      name: v.holds.domain?.name ?? "none.example.com",
      kind: "wildcard",
    }),
    true,
  ),
  "DELETE /v1/domains/:id": victim(),
  "POST /v1/domains/:id/check": victim({}),
  "GET /v1/projects/:ref/domains": victim(),
  "POST /v1/projects/:ref/domains": victim({ name: "stolen.example.com", kind: "exact" }),
  "PUT /v1/projects/:ref/production": victim({ previewId: null }),
  "GET /v1/previews/:id/domains": victim(),
  "POST /v1/previews/:id/domains": victim({ name: "stolen.example.com" }),
  "GET /v1/secrets": list(),
  "PATCH /v1/secrets": instance("secrets for every preview are the home org's", {
    set: { STOLEN: "1" },
  }),
  "GET /v1/previews/:id/env": victim(),
  "PATCH /v1/previews/:id/env": victim({ set: { STOLEN: "1" } }),
  "GET /v1/github": instance(SERVER),
  "GET /v1/github/repositories": instance(SERVER),
  "GET /v1/github/manifest": instance(SERVER),
  "POST /v1/github/manifest/exchange": instance(SERVER, { code: "c", state: "s" }),
};

/** The concrete paths that point a route at `v`'s things; empty when `v` holds none of them. */
export function aimAt(path: string, v: Org): string[] {
  const h = v.holds;
  const by: [RegExp, (string | undefined | null)[]][] = [
    [/\/previews\/:id/, h.previews],
    [/\/projects\/:ref/, [h.project?.slug, h.project?.id]],
    [/\/tokens\/:id/, [h.token]],
    [/\/domains\/:id/, [h.domain?.id]],
    [/\/v1\/templates\/:id/, [h.template]],
    [/\/artifact-themes\/:id/, [h.theme ?? "chart"]],
    [/\/artifact-templates\/:id\{\.\+\}/, ["document/memo"]],
    [/\/oauth\/grants\/:id/, [h.grant]],
    [/\/oauth\/requests\/:id/, ["not-a-request"]],
    [/\/users\/:id/, [h.user]],
    [/\/roles\/:id/, ["viewer"]],
  ];
  let out = [path];
  for (const [re, values] of by) {
    if (!re.test(path)) {
      continue;
    }
    const real = values.filter((x): x is string => typeof x === "string");
    const param = re.source.replaceAll("\\", "").split("/").at(-1)!;
    out = out.flatMap((p) => real.map((x) => p.replace(param, x)));
  }
  return out.map((p) => p.replace(":addon", "postgres").replace(":n", "1"));
}
