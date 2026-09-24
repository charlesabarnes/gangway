interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  SITE_URL: string;
}

export interface Signup {
  name: string;
  email: string;
  company: string;
  teamSize: string;
  previewDomain: string;
  previews: string;
  wouldDeploy: string;
}

export type Parsed =
  { kind: "signup"; signup: Signup } | { kind: "spam" } | { kind: "invalid"; error: string };

export const TEAM_SIZES = ["1", "2–10", "11–50", "51+"];
export const PREVIEW_COUNTS = ["under 10", "10–50", "50–200", "200+"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const choice = (value: unknown, options: string[]) => {
  const picked = text(value, 20);
  return options.includes(picked) ? picked : "";
};

export function parseSignup(input: Record<string, unknown>): Parsed {
  if (text(input.website, 200)) return { kind: "spam" };
  const signup: Signup = {
    name: text(input.name, 100),
    email: text(input.email, 254),
    company: text(input.company, 100),
    teamSize: choice(input.team_size, TEAM_SIZES),
    previewDomain: text(input.preview_domain, 253),
    previews: choice(input.previews, PREVIEW_COUNTS),
    wouldDeploy: text(input.would_deploy, 2000),
  };
  if (!signup.name) return { kind: "invalid", error: "Add your name." };
  if (!EMAIL.test(signup.email)) {
    return { kind: "invalid", error: "That email address does not look right." };
  }
  return { kind: "signup", signup };
}

const UPSERT = `INSERT INTO waitlist
  (email, name, company, team_size, preview_domain, previews, would_deploy, user_agent, country, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
  ON CONFLICT(email) DO UPDATE SET
    name = excluded.name, company = excluded.company, team_size = excluded.team_size,
    preview_domain = excluded.preview_domain, previews = excluded.previews,
    would_deploy = excluded.would_deploy, user_agent = excluded.user_agent,
    country = excluded.country, updated_at = excluded.updated_at`;

async function save(db: D1Database, s: Signup, request: Request): Promise<void> {
  const agent = (request.headers.get("user-agent") ?? "").slice(0, 300);
  const country = request.headers.get("cf-ipcountry") ?? "";
  await db
    .prepare(UPSERT)
    .bind(
      s.email,
      s.name,
      s.company,
      s.teamSize,
      s.previewDomain,
      s.previews,
      s.wouldDeploy,
      agent,
      country,
      new Date().toISOString(),
    )
    .run();
}

async function readBody(request: Request, json: boolean): Promise<Record<string, unknown> | null> {
  try {
    if (json) {
      const body: unknown = await request.json();
      return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    }
    return Object.fromEntries(await request.formData());
  } catch {
    return null;
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function reply(
  json: boolean,
  env: Env,
  cors: Record<string, string>,
  status: number,
  error?: string,
) {
  if (json) return Response.json(error ? { error } : { ok: true }, { status, headers: cors });
  if (!error) return Response.redirect(`${env.SITE_URL}/cloud.html#joined`, 303);
  const back = `${escape(env.SITE_URL)}/cloud.html#cloud`;
  const page = `<!doctype html><meta charset="utf-8"><title>gangway waitlist</title><p>${escape(error)}</p><p><a href="${back}">Back to the form</a></p>`;
  return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/waitlist") {
      return new Response("Not found", { status: 404 });
    }
    const origin = request.headers.get("origin") ?? "";
    const allowed = env.ALLOWED_ORIGINS.split(",").some((o) => o.trim() === origin);
    const cors = allowed ? corsHeaders(origin) : {};
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "POST, OPTIONS" },
      });
    }
    if (!allowed) return new Response("Forbidden", { status: 403 });

    const json = (request.headers.get("content-type") ?? "").includes("application/json");
    const input = await readBody(request, json);
    if (!input) return reply(json, env, cors, 400, "The form could not be read.");
    const parsed = parseSignup(input);
    if (parsed.kind === "invalid") return reply(json, env, cors, 400, parsed.error);
    if (parsed.kind === "signup") {
      try {
        await save(env.DB, parsed.signup, request);
      } catch {
        return reply(json, env, cors, 500, "The waitlist is not taking signups right now.");
      }
    }
    return reply(json, env, cors, 200);
  },
};
