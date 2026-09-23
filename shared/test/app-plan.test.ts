/** ADR-0016: the app plan -- conventions, gangway.yml, Procfile, nested roots -- as a pure function. */
import { describe, expect, test } from "bun:test";
import { cmdText, planApp, planError, planFilePaths, type AppPlan, type PlanInput } from "../src/app-plan.ts";
import { gangwayJsonSchema, parseGangwayFile } from "../src/gangway-file.ts";
import { DETECTION, detectRuntime, RUNTIMES } from "../src/runtimes.ts";

/** An upload as `{ path: contents }`; every file is listed, and the plan reads what it wants. */
const plan = (files: Record<string, string>, extra: Omit<PlanInput, "paths" | "files"> = {}): AppPlan =>
  planApp({ paths: Object.keys(files), files, ...extra });
const pkg = (o: Record<string, unknown>) => JSON.stringify(o);
const start = (p: AppPlan) => (p.start === null ? null : cmdText(p.start));

describe("detection is unchanged from ADR-0015", () => {
  test.each([
    [["compose.yaml", "package.json"], "own"],
    [["Dockerfile", "index.html"], "own"],
    [["wrangler.toml", "src/index.ts"], "workerd"],
    [["deno.json", "main.ts"], "deno"],
    [["bun.lock", "index.ts"], "bun"],
    [["requirements.txt", "main.py"], "python"],
    [["index.php"], "php"],
    [["index.ts"], "bun"],
    [["index.html", "style.css"], "static"],
  ])("%j -> %s", (paths, want) => {
    const p = planApp({ paths, files: Object.fromEntries(paths.map((x) => [x, x === "wrangler.toml" ? 'main = "src/index.ts"' : x.endsWith(".json") ? "{}" : ""])) });
    expect(p.kind === "own" ? "own" : p.runtime).toBe(want as never);
    expect(want).toBe(detectRuntime(paths) as never);
  });

  test("every starter plans without error as its own runtime", () => {
    for (const rt of RUNTIMES) {
      const p = plan(rt.starter, { runtime: rt.id });
      expect(planError(p)).toBeNull();
      expect(p.runtime).toBe(rt.id);
      expect(Object.values(rt.versions)).toContain(p.image!);
    }
  });
});

describe("node: Heroku's conventions", () => {
  test("npm start by default; install by lockfile; build if there is one", () => {
    const p = plan({ "package.json": pkg({ scripts: { start: "node server.js", build: "tsc" } }), "package-lock.json": "{}" });
    expect(p.runtime).toBe("node");
    expect(p.install).toBe("npm ci --no-audit --no-fund");
    expect(p.build).toBe("npm run build");
    expect(start(p)).toBe("npm start");
    expect(p.serve).toEqual({ kind: "server" });
  });

  test("pnpm and yarn by their lockfiles", () => {
    expect(plan({ "package.json": pkg({ scripts: { start: "x" } }), "pnpm-lock.yaml": "" }).install).toContain("pnpm install --frozen-lockfile");
    expect(plan({ "package.json": pkg({ scripts: { start: "x", build: "y" } }), "yarn.lock": "" }).build).toBe("yarn run build");
  });

  test("a Vite app (no start script) builds and serves dist/ with nginx -- the case that used to fail", () => {
    const p = plan({ "package.json": pkg({ scripts: { dev: "vite", build: "vite build" } }), "index.html": "", "src/main.ts": "" });
    expect(p.runtime).toBe("node");
    expect(p.build).toBe("npm run build");
    expect(p.start).toBeNull();
    expect(p.serve).toEqual({ kind: "static", output: null, fallback: "spa" });
    expect(planError(p)).toBeNull();
  });

  test("a start script that is a dev server, with a build: the build is served instead", () => {
    const p = plan({ "package.json": pkg({ scripts: { start: "react-scripts start", build: "react-scripts build" } }) });
    expect(p.serve.kind).toBe("static");
    expect(p.reasons.some((r) => r.found.includes("dev server"))).toBe(true);
  });

  test("a dev-server start with NO build runs, with a warning", () => {
    const p = plan({ "package.json": pkg({ scripts: { start: "vite" } }) });
    expect(start(p)).toBe("npm start");
    expect(p.reasons.find((r) => r.level === "warn")?.then).toContain("development server");
  });

  test("Next.js: build, then next start", () => {
    const p = plan({ "package.json": pkg({ scripts: { build: "next build", start: "next start", dev: "next dev" } }) });
    expect(p.build).toBe("npm run build");
    expect(start(p)).toBe("npm start");
    expect(p.serve.kind).toBe("server");
  });

  test("main, then an entry file, when there is no start script", () => {
    expect(start(plan({ "package.json": pkg({ main: "srv/app.js" }), "srv/app.js": "" }))).toBe("node srv/app.js");
    expect(start(plan({ "package.json": pkg({}), "server.js": "" }))).toBe("node server.js");
    // A main that leaves the upload is not an entry.
    expect(planError(plan({ "package.json": pkg({ main: "../../etc/passwd" }) }))).toContain("`start` script");
  });

  test("invalid package.json is an error, not a guess", () => {
    expect(planError(plan({ "package.json": "{ nope" }))).toContain("package.json is not valid JSON");
  });
});

describe("gangway.yml overrides the conventions", () => {
  test("start, build, install", () => {
    const p = plan({
      "gangway.yml": "install: npm ci --omit=dev\nbuild: false\nstart: [node, --enable-source-maps, dist/server.js]\n",
      "package.json": pkg({ scripts: { start: "x", build: "y" } }),
    });
    expect(p.install).toBe("npm ci --omit=dev");
    expect(p.build).toBeNull();
    expect(p.start).toEqual(["node", "--enable-source-maps", "dist/server.js"]);
    expect(p.configFile).toBe("gangway.yml");
  });

  test("static: a directory, or true to find one", () => {
    const p = plan({ "gangway.yml": "static: public/\n", "package.json": pkg({ scripts: { start: "node s.js", build: "b" } }) });
    expect(p.serve).toEqual({ kind: "static", output: "public", fallback: "spa" });
    expect(p.start).toBeNull();
    expect(plan({ "gangway.yml": "static: true\n", "package.json": pkg({ scripts: { build: "b" } }) }).serve).toMatchObject({ output: null });
  });

  test("runtime and version, from an allowlist", () => {
    const p = plan({ "gangway.yml": "runtime: node\nversion: 22\nstart: node x.js\n", "x.js": "" });
    expect(p.runtime).toBe("node");
    expect(p.image).toBe("node:22-alpine");
    const bad = plan({ "gangway.yml": "version: 19\n", "package.json": pkg({ scripts: { start: "x" } }) });
    expect(bad.issues).toEqual([{ path: "version", message: "Node.js offers 20, 22, 24" }]);
  });

  test("env, policy, health and release travel with the plan", () => {
    const p = plan({
      "gangway.yml": "env: { API_BASE: /api, RETRIES: 3 }\nttl: 2d\nidle: never\nvisibility: unlisted\nhealthcheck: /healthz\nrelease: npm run migrate\nseed: npm run seed\n",
      "package.json": pkg({ scripts: { start: "x" } }),
    });
    expect(p.env).toEqual({ API_BASE: "/api", RETRIES: "3" });
    expect(p.stack).toEqual({ ttl: "2d", idle: "never", visibility: "unlisted", seed: "npm run seed" });
    expect(p.health).toBe("/healthz");
    expect(p.release).toBe("npm run migrate");
  });

  test("problems name the key", () => {
    const p = plan({ "gangway.yml": "strat: npm start\nttl: forever\n", "package.json": "{}" });
    expect(p.issues.map((i) => i.path).sort()).toEqual(["", "ttl"]);
    expect(planError(p)).toContain("gangway.yml:");
    expect(plan({ "gangway.yml": "a: 1\na: 2\n" }).issues[0]!.message).toMatch(/unique|duplicate/i);
    expect(plan({ "gangway.yml": "root: ../x\n" }).issues[0]!.path).toBe("root");
    expect(plan({ "gangway.yml": "", "gangway.yaml": "" }).issues[0]!.message).toContain("both");
  });

  test("a compose file wins, and gangway.yml says it is ignored", () => {
    const p = plan({ "compose.yaml": "", "gangway.yml": "start: nope\n" });
    expect(p.kind).toBe("own");
    expect(p.reasons.some((r) => r.level === "warn" && r.found === "gangway.yml")).toBe(true);
    expect(planError(p)).toBeNull();
  });

  test("a lone Dockerfile takes its port and env from gangway.yml", () => {
    const p = plan({ Dockerfile: "FROM x", "gangway.yml": "port: 8081\nenv: { A: b }\n" });
    expect(p).toMatchObject({ kind: "own", port: 8081, env: { A: "b" } });
  });

  test("the static runtime ignores build steps and says so", () => {
    const p = plan({ "index.html": "", "gangway.yml": "runtime: static\nbuild: make\n" });
    expect(p.build).toBeNull();
    expect(p.reasons.some((r) => r.level === "warn" && r.found.startsWith("build"))).toBe(true);
  });
});

describe("Procfile", () => {
  test("web: runs, release: runs before each version, others are named and ignored", () => {
    const p = plan({ "requirements.txt": "flask\n", "app.py": "", Procfile: "web: gunicorn -b 0.0.0.0:$PORT app:app\nrelease: flask db upgrade\nworker: celery -A x\n# web: nope\n" });
    expect(p.runtime).toBe("python");
    expect(start(p)).toBe("gunicorn -b 0.0.0.0:$PORT app:app");
    expect(p.release).toBe("flask db upgrade");
    expect(p.reasons.some((r) => r.found === "Procfile: worker")).toBe(true);
  });
});

describe("other runtimes", () => {
  test("python: requirements or pyproject; an entry; Django's manage.py with a warning", () => {
    expect(plan({ "pyproject.toml": "", "main.py": "" }).install).toContain("pip install --no-cache-dir --root-user-action=ignore .");
    const dj = plan({ "requirements.txt": "django", "manage.py": "" });
    expect(start(dj)).toBe("python manage.py runserver 0.0.0.0:$PORT");
    expect(dj.reasons.some((r) => r.level === "warn")).toBe(true);
  });

  test("php: composer, and public/ as the docroot when it has index.php", () => {
    // Laravel: composer.json AND a package.json for its assets -- PHP, not Node.
    expect(plan({ "composer.json": "{}", "package.json": pkg({ scripts: { build: "vite build" } }), "artisan": "", "public/index.php": "" }).runtime).toBe("php");
    const p = plan({ "composer.json": "{}", "public/index.php": "", "index.php": "" });
    expect(p.install).toContain("composer install");
    expect(p.docroot).toBe("public");
    expect(plan({ "index.php": "" })).toMatchObject({ install: null, docroot: "" });
  });

  test("deno: tasks.start beats the entry", () => {
    const p = plan({ "deno.json": pkg({ tasks: { start: "deno run -A server.ts" } }), "server.ts": "" });
    expect(start(p)).toBe("deno task start");
    expect(p.entry).toBeNull();
  });

  test("bun: a start script, else the Workers-style entry", () => {
    expect(start(plan({ "bun.lock": "", "package.json": pkg({ scripts: { start: "bun run serve.ts" } }) }))).toBe("bun run start");
    const w = plan({ "index.ts": "" });
    expect(w).toMatchObject({ runtime: "bun", entry: "index.ts", start: null });
  });

  test("workerd: wrangler's main", () => {
    expect(plan({ "wrangler.toml": 'main = "src/w.ts"\n', "src/w.ts": "" }).entry).toBe("src/w.ts");
  });
});

describe("where the app is", () => {
  test("one directory holding the app, nothing recognisable beside it: that directory", () => {
    const p = plan({ "README.md": "", "docs/a.md": "", "web/package.json": pkg({ scripts: { start: "node s.js" } }), "web/s.js": "" });
    // docs/ has no marker; web/ does.
    expect(p.root).toBe("web");
    expect(p.runtime).toBe("node");
    expect(start(p)).toBe("npm start");
  });

  test("two candidate directories: no guess", () => {
    const p = plan({ "a/index.html": "", "b/index.html": "" });
    expect(p.root).toBe("");
  });

  test("root: in gangway.yml, and a gangway.yml inside the nested app is read", () => {
    expect(plan({ "gangway.yml": "root: apps/site\n", "apps/site/index.html": "", "apps/api/package.json": "{}" })).toMatchObject({ root: "apps/site", runtime: "static" });
    expect(plan({ "gangway.yml": "root: nope\n" }).issues[0]!.path).toBe("root");
    expect(plan({ "site/gangway.yml": "runtime: static\n", "site/x.txt": "" })).toMatchObject({ root: "site", runtime: "static", configFile: "site/gangway.yml" });
  });
});

describe("a rebuild", () => {
  test("keeps the previous runtime under auto, unless gangway.yml names one", () => {
    expect(plan({ "main.ts": "" }, { previous: "deno" }).runtime).toBe("deno");
    expect(plan({ "main.ts": "", "gangway.yml": "runtime: bun\n" }, { previous: "deno" }).runtime).toBe("bun");
    expect(plan({ "index.ts": "", Dockerfile: "" }, { previous: "bun" }).kind).toBe("runtime");
    expect(plan({ "compose.yaml": "" }, { previous: "own" }).kind).toBe("own");
  });
});

test("planFilePaths: only the files the plan reads, at the root and one level down", () => {
  expect(planFilePaths(["package.json", "web/package.json", "a/b/package.json", "src/x.ts", "gangway.yml", "Procfile"]))
    .toEqual(["package.json", "web/package.json", "gangway.yml", "Procfile"]);
});

test("gangway.yml's JSON Schema is valid JSON with every key", () => {
  const schema = gangwayJsonSchema() as { properties: Record<string, unknown> };
  for (const k of ["runtime", "start", "build", "static", "env", "release", "healthcheck", "root"]) expect(schema.properties[k]).toBeDefined();
  expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
});

test("parseGangwayFile: empty is the conventions; a non-mapping is refused; aliases are bounded", () => {
  expect(parseGangwayFile("")).toEqual({ ok: true, file: {} });
  expect(parseGangwayFile("- a\n- b\n")).toMatchObject({ ok: false });
  const bomb = `a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n`;
  expect(parseGangwayFile(bomb)).toMatchObject({ ok: false });
});

test("the detection data the UI gets still starts with own", () => {
  expect(DETECTION[0]!.runtime).toBe("own");
});
