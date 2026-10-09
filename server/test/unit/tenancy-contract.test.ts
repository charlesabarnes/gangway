/**
 * The tenancy contract: one real boot, three orgs, and every route the app answers walked by one
 * org against another's things. A route missing from ROUTES fails here; see tenancy-routes.ts.
 */
import { beforeEach, expect, test } from "bun:test";
import { APP, browser } from "../helpers/boot-e2e.ts";
import { aimAt, ROUTES, type Body, type Rule } from "../helpers/tenancy-routes.ts";
import { bootWorld, leaked, snapshot, type Org, type World } from "../helpers/tenancy-world.ts";
import { tarball } from "../helpers/runtimes-fixtures.ts";
import { client } from "../helpers/fake-daemon.ts";

let world: World;

// A fresh world for each test: the cleanup after every test stops the server it booted.
beforeEach(async () => {
  world = await bootWorld();
}, 30_000);

const keyOf = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

test("every route the app answers says what one org may get from it", () => {
  const answered = new Set(world.running.routes().map(keyOf));
  const missing = [...answered].filter((k) => !(k in ROUTES));
  const stale = Object.keys(ROUTES).filter((k) => !answered.has(k));
  expect({ missing, stale }).toEqual({ missing: [], stale: [] });
});

async function init(method: string, body: Body | undefined, v: Org): Promise<RequestInit> {
  if (body === undefined) {
    return { method };
  }
  if (body === "tarball") {
    return {
      method,
      headers: { "content-type": "application/gzip" },
      body: await tarball({ "index.html": "<h1>mine</h1>" }),
    };
  }
  const json = typeof body === "function" ? body(v) : body;
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(json) };
}

type Pair = { attacker: Org; victim: Org };

/** Reads an event stream from the start for a moment, then hangs up. */
async function readStream(a: Org, path: string): Promise<{ status: number; text: string }> {
  const stop = new AbortController();
  const res = await a.as(path, { signal: stop.signal });
  let text = "";
  const reader = res.body!.getReader();
  const timer = setTimeout(() => stop.abort(), 300);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += new TextDecoder().decode(value);
    }
  } catch {
    // The hang-up.
  } finally {
    clearTimeout(timer);
  }
  return { status: res.status, text };
}

/** What is wrong with one call, or null. */
function judge(rule: Rule, { attacker, victim }: Pair, status: number, text: string) {
  const ok2xx = status >= 200 && status < 300;
  const found = ok2xx ? leaked(text, victim) : [];
  if (status >= 500) {
    return `answered ${status}`;
  }
  switch (rule.kind) {
    case "victim":
      return status === 403 || status === 404 ? null : `answered ${status}, not 403/404`;
    case "instance":
    case "operator":
      if (!attacker.home) {
        return status === 403 ? null : `answered ${status} to another org, not 403`;
      }
      return found.length ? `carried ${found.join(", ")}` : null;
    case "own":
      if (rule.refused && ok2xx) {
        return `answered ${status} to a body naming another org's thing`;
      }
      return found.length ? `carried ${found.join(", ")}` : null;
    case "list":
    case "stream":
    case "shared":
    case "public":
    case "middleware":
      return found.length ? `carried ${found.join(", ")}` : null;
  }
}

async function call(rule: Rule, method: string, path: string, pair: Pair) {
  const { attacker, victim } = pair;
  if (rule.kind === "stream") {
    return readStream(attacker, path);
  }
  if (rule.kind === "public") {
    const res = await browser(world.running)(APP, path);
    return { status: res.status, text: await res.text() };
  }
  const query = "query" in rule && rule.query ? rule.query : "";
  const body = "body" in rule ? rule.body : undefined;
  const signal = AbortSignal.timeout(5_000);
  try {
    const res = await attacker.as(path + query, { ...(await init(method, body, victim)), signal });
    return { status: res.status, text: await res.text() };
  } catch {
    // A request that reached another org's thing may sit on it; it is a failure, not a hang.
    return { status: 599, text: "no answer in 5 s" };
  }
}

function echoless(text: string, rule: Rule, v: Org): string {
  const body = "body" in rule ? rule.body : undefined;
  const sent = typeof body === "function" ? JSON.stringify(body(v)) : "";
  return v.markers.filter((m) => sent.includes(m)).reduce((t, m) => t.replaceAll(m, "…"), text);
}

/** Whether to make this call at all: the home org's own server routes are its to change. */
function skip(rule: Rule, method: string, attacker: Org): boolean {
  if (rule.kind === "middleware" || (rule.kind === "public" && method !== "GET")) {
    return true;
  }
  const serverWide = rule.kind === "instance" || rule.kind === "operator";
  return serverWide && attacker.home && method !== "GET";
}

test("no org reads or changes another org's things through any route", async () => {
  const { home, aye, bee } = world.orgs;
  const pairs: Pair[] = [
    { attacker: aye, victim: bee },
    { attacker: aye, victim: home },
    { attacker: home, victim: bee },
  ];
  const failures: string[] = [];
  for (const [key, rule] of Object.entries(ROUTES)) {
    const [method, path] = key.split(" ") as [string, string];
    for (const pair of pairs) {
      if (skip(rule, method, pair.attacker)) {
        continue;
      }
      for (const aimed of aimAt(path, pair.victim)) {
        const before = snapshot(world.dir, pair.victim);
        const { status, text: answered } = await call(rule, method, aimed, pair);
        // A request's own words come back in its answer; only what it did not send can leak.
        const text = echoless(answered, rule, pair.victim);
        const wrong = judge(rule, pair, status, text);
        const who = `${pair.attacker.slug} -> ${pair.victim.slug} ${method} ${aimed}`;
        if (wrong) {
          failures.push(`${who}: ${wrong} ${text.slice(0, 160)}`);
        }
        if (snapshot(world.dir, pair.victim) !== before) {
          failures.push(`${who}: changed ${pair.victim.slug}'s things`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
}, 60_000);

test("a live event stream carries nothing of another org's", async () => {
  const { home, aye, bee } = world.orgs;
  const reading = [aye, home].map((o) => readStream(o, "/v1/events"));
  const own = readStream(bee, "/v1/events");
  await Bun.sleep(50);
  const changed = await bee.as(`/v1/previews/${bee.holds.previews[0]}/title`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "bee-live-title" }),
  });
  expect(changed.status).toBe(200);
  expect((await own).text).toContain(bee.holds.previews[0]!);
  for (const [i, o] of [aye, home].entries()) {
    const { status, text } = await reading[i]!;
    expect({ org: o.slug, status, leaked: leaked(text, bee) }).toEqual({
      org: o.slug,
      status: 200,
      leaked: [],
    });
  }
});

test("the auth gate lets no other org into a private preview", async () => {
  const { home, aye, bee } = world.orgs;
  const gate = (o: Org) =>
    client(world.running)(APP, `/v1/auth/gate?host=${bee.holds.privateHost}&to=/`, {
      headers: { authorization: `Bearer ${o.secret}` },
    });
  expect((await gate(bee)).status).toBe(302);
  for (const other of [aye, home]) {
    const res = await gate(other);
    expect({ org: other.slug, status: res.status }).toEqual({ org: other.slug, status: 404 });
  }
});

test("the auth gate lets no other org skip a preview's password", async () => {
  const { home, aye, bee } = world.orgs;
  const site = bee.holds.previews[1]!;
  const set = await bee.as(`/v1/previews/${site}/password`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: { mode: "generate" }, login: "on" }),
  });
  expect(set.status).toBe(200);
  const { preview } = (await (await bee.as(`/v1/previews/${site}`)).json()) as {
    preview: { urls: { url: string }[] };
  };
  const host = new URL(preview.urls[0]!.url).hostname;
  const landing = async (o: Org) => {
    const res = await client(world.running)(APP, `/v1/auth/gate?host=${host}&to=/`, {
      headers: { authorization: `Bearer ${o.secret}` },
    });
    return new URL(res.headers.get("location") ?? "https://x/none").pathname;
  };
  expect(await landing(bee)).toBe("/__gangway/auth");
  expect(await landing(aye)).toBe("/__gangway/password");
  expect(await landing(home)).toBe("/__gangway/password");
});
