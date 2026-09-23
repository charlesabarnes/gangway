import type { Hono } from "hono";
import { z } from "zod";
import { notFound } from "../../errors.ts";
import { OAuthError, type OAuthServer } from "../../oauth/server.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { problemResponse, readJson } from "../problem.ts";

export type OAuthRouteDeps = {
  oauth: OAuthServer;
  enabled: () => boolean;
};

const DecideSchema = z.strictObject({
  approve: z.boolean(),
  scopes: z.array(z.string().max(32)).max(8).optional(),
});

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function errorPage(message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cannot connect</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#171717}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#e5e5e5}}</style>
<h1 style="font-size:1.25rem">This app cannot connect to gangway</h1><p>${escape(message)}</p><p>Nothing was granted. Go back to the app that sent you and try again, or tell whoever runs it.</p>`;
  return new Response(html, {
    status: 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

class Budget {
  readonly #hits = new Map<string, { n: number; since: number }>();
  readonly #perMinute: number;
  readonly #now: () => number;
  constructor(perMinute: number, now: () => number = Date.now) {
    this.#perMinute = perMinute;
    this.#now = now;
  }
  take(key: string): boolean {
    const t = this.#now();
    const h = this.#hits.get(key);
    if (!h || t - h.since > 60_000) {
      if (this.#hits.size > 10_000) this.#hits.clear();
      this.#hits.set(key, { n: 1, since: t });
      return true;
    }
    return ++h.n <= this.#perMinute;
  }
}

export function oauthRootRoutes(app: Hono<AppEnv>, d: OAuthRouteDeps): void {
  const budget = new Budget(60);
  const on = (surface: string) => surface === "app" && d.enabled();

  app.get("/.well-known/oauth-authorization-server", (c) => {
    if (!on(c.env.surface)) return problemResponse(c, notFound(`no such resource: ${c.req.path}`));
    return c.json(d.oauth.metadata(), 200, { "cache-control": "public, max-age=300" });
  });

  app.get("/oauth/authorize", async (c) => {
    if (!on(c.env.surface)) return problemResponse(c, notFound(`no such resource: ${c.req.path}`));
    const out = await d.oauth.authorize(new URLSearchParams(new URL(c.req.url).search));
    if (out.kind === "page") return errorPage(out.error);
    const to =
      out.kind === "redirect" ? out.url : `/connect?request=${encodeURIComponent(out.requestId)}`;
    return new Response(null, {
      status: 302,
      headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  });

  app.post("/oauth/token", async (c) => {
    if (!on(c.env.surface)) return problemResponse(c, notFound(`no such resource: ${c.req.path}`));
    const fail = (code: string, description: string, status = 400) =>
      c.json({ error: code, error_description: description }, status as 400, NO_STORE);
    if (!budget.take(c.env.clientIp))
      return c.json(
        { error: "slow_down", error_description: "too many token requests; wait a minute" },
        429,
        { ...NO_STORE, "retry-after": "60" },
      );
    if (
      !(c.req.header("content-type") ?? "")
        .toLowerCase()
        .startsWith("application/x-www-form-urlencoded")
    ) {
      return fail("invalid_request", "the token endpoint takes application/x-www-form-urlencoded");
    }
    const text = await c.req.text();
    if (text.length > 16 * 1024) return fail("invalid_request", "the request is too large");
    const form = new URLSearchParams(text);
    for (const k of new Set(form.keys()))
      if (form.getAll(k).length > 1)
        return fail("invalid_request", `${k} was given more than once`);
    if (form.has("client_secret") || c.req.header("authorization"))
      return fail(
        "invalid_client",
        "gangway serves public clients only; send no client secret",
        401,
      );
    try {
      return c.json(d.oauth.token(form), 200, NO_STORE);
    } catch (err) {
      if (err instanceof OAuthError) return fail(err.code, err.message, err.status);
      throw err;
    }
  });
}

export function oauthRoutes(api: Hono<AppEnv>, d: OAuthRouteDeps): void {
  const guard = () => {
    if (!d.enabled()) throw notFound("MCP is switched off");
  };

  api.get("/oauth/requests/:id", requirePermission("tokens.manage_own"), (c) => {
    guard();
    return c.json({ request: d.oauth.view(c.get("actor"), c.req.param("id")) });
  });

  api.post("/oauth/requests/:id", requirePermission("tokens.manage_own"), async (c) => {
    guard();
    const body = DecideSchema.parse(await readJson(c));
    return c.json(d.oauth.decide(c.get("actor"), c.req.param("id"), body));
  });

  api.get("/oauth/grants", requirePermission("tokens.manage_own"), (c) =>
    c.json({ grants: d.oauth.list(c.get("actor"), { all: c.req.query("all") === "true" }) }),
  );

  api.delete("/oauth/grants/:id", requirePermission("tokens.manage_own"), (c) =>
    c.json({ grant: d.oauth.revoke(c.get("actor"), c.req.param("id")) }),
  );
}
