import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import worker, { type Env, parseSignup } from "../src/index.ts";

const SITE = "https://charlesabarnes.github.io";
let sqlite: Database;
let env: Env;

function d1(db: Database): Env["DB"] {
  return {
    prepare: (sql) => {
      let values: unknown[] = [];
      const stmt = {
        bind: (...v: unknown[]) => ((values = v), stmt),
        run: async () => db.prepare(sql).run(...(values as string[])),
      };
      return stmt;
    },
  };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.run(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  env = {
    DB: d1(sqlite),
    ALLOWED_ORIGINS: `${SITE}, http://localhost:4173`,
    SITE_URL: `${SITE}/gangway`,
  };
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request("https://w.example/waitlist", {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );

const rows = () => sqlite.query("SELECT * FROM waitlist").all() as Record<string, string>[];

describe("parseSignup", () => {
  test("trims fields and drops a select value that is not one of the options", () => {
    const parsed = parseSignup({ name: " Dana ", email: "dana@acme.dev", team_size: "9000" });
    expect(parsed).toMatchObject({ kind: "signup", signup: { name: "Dana", teamSize: "" } });
  });

  test("a filled honeypot is spam", () => {
    expect(parseSignup({ name: "x", email: "x@y.z", website: "http://spam" }).kind).toBe("spam");
  });
});

describe("POST /waitlist", () => {
  test("stores a signup and answers ok", async () => {
    const res = await post({ name: "Dana", email: "dana@acme.dev", team_size: "2–10" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(rows()).toMatchObject([{ email: "dana@acme.dev", team_size: "2–10" }]);
  });

  test("signing up again with the same email in another case updates the row", async () => {
    await post({ name: "Dana", email: "dana@acme.dev", company: "Acme" });
    await post({ name: "Dana R", email: "DANA@acme.dev", company: "Acme 2" });
    expect(rows()).toMatchObject([{ email: "dana@acme.dev", name: "Dana R", company: "Acme 2" }]);
  });

  test("rejects a bad email with a message and stores nothing", async () => {
    const res = await post({ name: "Dana", email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That email address does not look right." });
    expect(rows()).toHaveLength(0);
  });

  test("answers ok to the honeypot without storing it", async () => {
    const res = await post({ name: "Bot", email: "bot@x.io", website: "spam" });
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  test("refuses an origin that is not allowed", async () => {
    const res = await post(
      { name: "Dana", email: "dana@acme.dev" },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  test("a plain form post redirects back to the page", async () => {
    const res = await post("name=Dana&email=dana%40acme.dev", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SITE}/gangway/cloud.html#joined`);
    expect(rows()).toHaveLength(1);
  });

  test("a plain form post with a bad email gets an HTML page back", async () => {
    const res = await post("name=Dana&email=nope", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not look right");
  });

  test("a database failure is a 500 with a message", async () => {
    sqlite.run("DROP TABLE waitlist");
    const res = await post({ name: "Dana", email: "dana@acme.dev" });
    expect(res.status).toBe(500);
  });
});

test("preflight from an allowed origin gets CORS headers", async () => {
  const res = await worker.fetch(
    new Request("https://w.example/waitlist", { method: "OPTIONS", headers: { origin: SITE } }),
    env,
  );
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
});
