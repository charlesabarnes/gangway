/**
 * The app plan (ADR-0016): from what an upload holds, HOW gangway will build and run it --
 * and why. One pure function over the file list and a few small files' contents, so the
 * server (which reads them from disk) and the New screen (which asks the server before it
 * uploads) can never disagree.
 *
 * The conventions are Heroku's: install by lockfile, `build` if there is one, `start` to
 * run it. `gangway.yml` overrides any of them (shared/src/gangway-file.ts), and a Procfile's
 * `web:` is honoured. What this decides, the server turns into `.gangway/` build files
 * (server/src/previews/runtimes.ts); nothing here touches a disk or a process.
 */
import {
  GANGWAY_FILES,
  isRelPath,
  parseGangwayFile,
  type Command,
  type FileIssue,
  type GangwayFile,
} from "./gangway-file.ts";
import { ADDONS, addonById, isSql, type AddonChoice, type AddonId } from "./addons.ts";
import {
  DETECTION,
  detectRuntime,
  runtimeById,
  type Detected,
  type Runtime,
  type RuntimeId,
} from "./runtimes.ts";

/** Files whose CONTENTS the plan reads, at the app root (or one directory down, for a nested app). */
export const PLAN_FILES = [
  ...GANGWAY_FILES,
  "package.json",
  "Procfile",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
  "requirements.txt",
  "pyproject.toml",
] as const;
/** Per file. package.json files are small; a larger one is read as absent and says so. */
export const MAX_PLAN_FILE_BYTES = 256 * 1024;

export type PlanChoice = RuntimeId | "auto" | "own";

export type PlanInput = {
  /** Every file in the upload, relative, forward-slashed. */
  paths: readonly string[];
  /** Contents of PLAN_FILES by path, at the root and one directory down. Missing: not read. */
  files: Readonly<Partial<Record<string, string>>>;
  /** What was asked for. Omitted: `auto`. */
  runtime?: PlanChoice | undefined;
  /**
   * A rebuild's previous runtime (`own` for an own stack). Under `auto` it beats detection --
   * an edit does not re-guess -- but not a `runtime:` in gangway.yml, which is the upload
   * saying what it wants.
   */
  previous?: Detected | undefined;
  /** Add-ons asked for with the request (ADR-0017); given -- even empty -- it beats gangway.yml. */
  addons?: readonly AddonRequest[] | undefined;
  /** A rebuild's add-ons, kept unless the request or gangway.yml says otherwise. A major is never changed in place. */
  previousAddons?: readonly AddonChoice[] | undefined;
};

export type AddonRequest = AddonId | { id: AddonId; version?: string | undefined };

/** One line of "what was found, so what will happen". `error` means the plan cannot run. */
export type Reason = { level: "info" | "warn" | "error"; found: string; then: string };

export type AppPlan = {
  /** `own`: the upload's compose file or Dockerfile; everything below is advisory. */
  kind: "own" | "runtime";
  runtime: RuntimeId | null;
  version: string | null;
  /** The pinned base image the build starts FROM. */
  image: string | null;
  /** The app's directory within the upload; "" is its root. The build context. */
  root: string;
  install: Command | null;
  build: Command | null;
  /** Null when nginx or Apache serves it (static, php, a static build) or workerd runs it. */
  start: Command | null;
  release: Command | null;
  /**
   * `server`: a process listens on $PORT. `static`: nginx serves files -- the upload's own
   * (runtime static) or a build's output (`output`: a directory, or null to find one).
   */
  serve:
    | { kind: "server" }
    | { kind: "static"; output: string | null | false; fallback: "spa" | "404" | "listing" };
  /** PHP: the directory Apache serves, relative to root. "" is root itself. */
  docroot: string;
  /** The file the runtime's own wrapper runs (bun, deno, workerd), when no start command does. */
  entry: string | null;
  /** From gangway.yml. Null: the runtime's own. */
  port: number | null;
  health: string | null;
  env: Record<string, string>;
  /** Stack-level policy from gangway.yml; the generated compose file carries it as `x-gangway`. */
  stack: {
    ttl?: string;
    visibility?: "public" | "unlisted" | "private";
    idle?: string;
    seed?: string;
  };
  /** Which gangway.yml was read, if any. */
  configFile: string | null;
  /** Throwaway databases beside the app (ADR-0017). */
  addons: AddonChoice[];
  /** Add-ons the dependencies point at, not chosen. The New screen pre-ticks them; the server never adds one. */
  suggested: { id: AddonId; because: string }[];
  /** A SQL file the first SQL add-on loads on its first start, relative to root. */
  sqlSeed: string | null;
  reasons: Reason[];
  /** gangway.yml problems, by key path. Non-empty means the plan cannot run. */
  issues: FileIssue[];
};

export const cmdText = (c: Command): string =>
  typeof c === "string" ? c : c.map(shellQuote).join(" ");
export const shellQuote = (s: string): string =>
  /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The first error, as the message a refusal carries. */
export function planError(p: AppPlan): string | null {
  if (p.issues.length > 0)
    return `gangway.yml: ${p.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`;
  const e = p.reasons.find((r) => r.level === "error");
  return e ? `${e.found}: ${e.then}` : null;
}

/** Dev servers refuse a preview's hostname (Vite's host check) and are not what to ship. */
const DEV_SERVER =
  /^\s*(?:npx\s+)?(?:vite(?:\s+dev)?|next\s+dev|nuxt\s+dev|ng\s+serve|react-scripts\s+start|vue-cli-service\s+serve|astro\s+dev|svelte-kit\s+dev|webpack(?:-dev-server|\s+serve)|parcel(?!\s+build))(?:\s|$)/;

const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const STATIC_OUTPUTS = ["dist", "build", "out", ".output/public", "dist/*/browser"];

type Pm = {
  name: "npm" | "pnpm" | "yarn" | "bun";
  install: string;
  run: (script: string) => string;
};

function packageManager(have: Set<string>): Pm {
  if (have.has("pnpm-lock.yaml"))
    return {
      name: "pnpm",
      install: "corepack enable && pnpm install --frozen-lockfile",
      run: (s) => `pnpm run ${s}`,
    };
  if (have.has("yarn.lock"))
    return {
      name: "yarn",
      install: "corepack enable && yarn install",
      run: (s) => `yarn run ${s}`,
    };
  const locked = have.has("package-lock.json") || have.has("npm-shrinkwrap.json");
  return {
    name: "npm",
    install: locked ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund",
    run: (s) => (s === "start" ? "npm start" : `npm run ${s}`),
  };
}

type Json = Record<string, unknown>;
function readJson(text: string | undefined, name: string, reasons: Reason[]): Json | null {
  if (text === undefined) return null;
  try {
    // JSONC (deno.jsonc, wrangler.jsonc): line comments off, well enough for the keys we read.
    const v = JSON.parse(name.endsWith("c") ? text.replace(/^\s*\/\/.*$/gm, "") : text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Json;
  } catch {
    /* below */
  }
  reasons.push({
    level: "error",
    found: `${name} is not valid JSON`,
    then: "fix it, or the install step would fail anyway",
  });
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const scriptsOf = (pkg: Json | null): Record<string, string> =>
  Object.fromEntries(
    Object.entries((pkg?.["scripts"] ?? {}) as Json).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;

/** `web: gunicorn app:app` -> { web: "gunicorn app:app" }. */
export function parseProcfile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]!] = m[2]!;
  }
  return out;
}

/** A path named in the upload's own config (package.json `main`), checked to stay inside it and to exist. */
function entryFrom(have: Set<string>, rel: unknown): string | null {
  if (typeof rel !== "string" || rel === "") return null;
  const parts: string[] = [];
  for (const seg of rel.replace(/^\.\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const norm = parts.join("/");
  return isRelPath(norm) && have.has(norm) ? norm : null;
}

const firstEntry = (have: Set<string>, rt: Runtime): string | null =>
  rt.entries.find((e) => have.has(e)) ?? null;
const noEntry = (rt: Runtime, extra = ""): Reason => ({
  level: "error",
  found: `no entry file for ${rt.name}`,
  then: `the ${rt.name} runtime needs an entry file${extra}: one of ${rt.entries.join(", ")}`,
});

/** Markers that make a directory an app (not `own`: a Dockerfile counts only at the root). */
const APP_MARKERS = new Set([
  ...DETECTION.filter((r) => r.runtime !== "own").flatMap((r) => r.markers),
  ...GANGWAY_FILES,
  "index.html",
  "Procfile",
]);

/**
 * With nothing recognisable at the root and exactly ONE top-level directory that looks like
 * an app, that directory is the app: `my-repo/web/package.json` in a folder that also holds
 * a README and some docs.
 */
function nestedRoot(paths: readonly string[]): string | null {
  if (paths.some((p) => !p.includes("/") && APP_MARKERS.has(p))) return null;
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length === 2 && APP_MARKERS.has(parts[1]!)) dirs.add(parts[0]!);
  }
  return dirs.size === 1 ? [...dirs][0]! : null;
}

export function planApp(input: PlanInput): AppPlan {
  const reasons: Reason[] = [];
  const choice = input.runtime ?? "auto";
  const plan: AppPlan = {
    kind: "runtime",
    runtime: null,
    version: null,
    image: null,
    root: "",
    install: null,
    build: null,
    start: null,
    release: null,
    serve: { kind: "server" },
    docroot: "",
    entry: null,
    port: null,
    health: null,
    env: {},
    stack: {},
    configFile: null,
    reasons,
    issues: [],
    addons: [],
    suggested: [],
    sqlSeed: null,
  };

  // ---- the config file: at the upload root, else (below) at a nested app's root
  const readConfig = (dir: string): { name: string; file: GangwayFile | null } | null => {
    const at = (n: string) => (dir ? `${dir}/${n}` : n);
    const present = GANGWAY_FILES.filter((n) => input.paths.includes(at(n)));
    if (present.length === 0) return null;
    if (present.length > 1) {
      plan.issues.push({
        path: "",
        message: "both gangway.yml and gangway.yaml are present; keep one",
      });
      return { name: at(present[0]!), file: null };
    }
    const name = at(present[0]!);
    const text = input.files[name];
    if (text === undefined) {
      plan.issues.push({
        path: "",
        message: `${name} could not be read (larger than ${MAX_PLAN_FILE_BYTES / 1024} KiB?)`,
      });
      return { name, file: null };
    }
    const parsed = parseGangwayFile(text);
    if (!parsed.ok) {
      plan.issues.push(...parsed.issues);
      return { name, file: null };
    }
    return { name, file: parsed.file };
  };

  const rootPaths = new Set(input.paths.filter((p) => !p.includes("/")));
  const hasCompose = COMPOSE_NAMES.some((m) => rootPaths.has(m));
  let cfg = readConfig("");

  // ---- own stack: a compose file or Dockerfile at the root, asked for or detected
  const detectedAtRoot = detectRuntime(input.paths.filter((p) => !p.includes("/")));
  const autoOwn =
    input.previous !== undefined ? input.previous === "own" : detectedAtRoot === "own";
  if (choice === "own" || (choice === "auto" && !cfg?.file?.runtime && autoOwn)) {
    plan.kind = "own";
    if (hasCompose) {
      reasons.push({
        level: "info",
        found: "a compose file",
        then: "runs it as it is; x-gangway in it sets the preview's policy",
      });
      if (cfg)
        reasons.push({
          level: "warn",
          found: cfg.name,
          then: "is ignored: the compose file is the whole configuration",
        });
      plan.issues = [];
    } else if (rootPaths.has("Dockerfile")) {
      plan.port = cfg?.file?.port ?? null;
      plan.env = cfg?.file?.env ?? {};
      plan.health = cfg?.file?.healthcheck ?? null;
      plan.stack = stackOf(cfg?.file);
      plan.configFile = cfg?.name ?? null;
      reasons.push({
        level: "info",
        found: "a Dockerfile",
        then: plan.port
          ? `builds it and routes to port ${plan.port}`
          : "builds it; say which port it listens on (`port:` in gangway.yml, or ?port=)",
      });
    } else {
      reasons.push({
        level: "error",
        found: "no compose file or Dockerfile at the root",
        then: "choose a runtime to build it with instead",
      });
    }
    if (hasCompose) {
      if ((input.addons?.length ?? 0) > 0)
        reasons.push({
          level: "error",
          found: "add-ons with a compose file",
          then: "declare the database as a service in the compose file instead",
        });
    } else if (rootPaths.has("Dockerfile")) {
      resolveAddons(plan, input, cfg?.file ?? null, new Set(input.paths));
    }
    return plan;
  }

  // ---- the app's root
  const explicitRoot = cfg?.file?.root;
  if (explicitRoot !== undefined) {
    if (!input.paths.some((p) => p.startsWith(`${explicitRoot}/`))) {
      plan.issues.push({
        path: "root",
        message: `${explicitRoot}/ is not a directory in the upload`,
      });
      return plan;
    }
    plan.root = explicitRoot;
    reasons.push({
      level: "info",
      found: `root: ${explicitRoot}`,
      then: `builds ${explicitRoot}/ as the app`,
    });
  } else if (!cfg) {
    const nested = nestedRoot(input.paths);
    if (nested) {
      plan.root = nested;
      reasons.push({
        level: "info",
        found: `the app is in ${nested}/`,
        then: `builds ${nested}/ (set \`root:\` in gangway.yml to choose another)`,
      });
      cfg = readConfig(nested);
    }
  }
  const at = (n: string) => (plan.root ? `${plan.root}/${n}` : n);
  const paths = plan.root
    ? input.paths
        .filter((p) => p.startsWith(`${plan.root}/`))
        .map((p) => p.slice(plan.root.length + 1))
    : [...input.paths];
  const have = new Set(paths);
  const text = (n: string) => input.files[at(n)];
  const file = cfg?.file ?? null;
  plan.configFile = cfg?.name ?? null;
  if (plan.issues.length > 0) return plan;
  if (plan.root && (have.has("Dockerfile") || DETECTION[0]!.markers.some((m) => have.has(m)))) {
    reasons.push({
      level: "warn",
      found: `${plan.root}/ has a Dockerfile or compose file`,
      then: "gangway uses those only at the upload's root; building with a runtime instead",
    });
  }

  // ---- which runtime: asked for, gangway.yml's, detected
  let runtime: RuntimeId;
  if (choice !== "auto") {
    runtime = choice;
    if (file?.runtime && file.runtime !== choice)
      reasons.push({
        level: "info",
        found: `gangway.yml says ${file.runtime}`,
        then: `building as ${runtimeById(choice).name}, as asked`,
      });
  } else if (file?.runtime) {
    runtime = file.runtime;
    reasons.push({
      level: "info",
      found: `runtime: ${file.runtime}`,
      then: `builds it as ${runtimeById(runtime).name}`,
    });
  } else if (input.previous !== undefined && input.previous !== "own") {
    runtime = input.previous;
    reasons.push({
      level: "info",
      found: "the previous build",
      then: `builds it as ${runtimeById(runtime).name} again`,
    });
  } else {
    const d: Detected = detectRuntime(paths);
    runtime = d === "own" ? "static" : d; // own only at the root, handled above
    const marker = DETECTION.filter((r) => r.runtime === runtime)
      .flatMap((r) => r.markers)
      .find((m) => have.has(m));
    reasons.push({
      level: "info",
      found: marker ?? "no marker file",
      then: `looks like ${runtimeById(runtime).name}`,
    });
  }
  const rt = runtimeById(runtime);
  plan.runtime = runtime;

  // ---- version
  const defaultVersion =
    Object.keys(rt.versions).find((v) => rt.versions[v] === rt.image) ??
    Object.keys(rt.versions)[0]!;
  plan.version = defaultVersion;
  if (file?.version !== undefined) {
    if (rt.versions[file.version] === undefined) {
      plan.issues.push({
        path: "version",
        message: `${rt.name} offers ${Object.keys(rt.versions).join(", ")}`,
      });
      return plan;
    }
    plan.version = file.version;
  }
  plan.image = rt.versions[plan.version]!;

  // ---- the rest of gangway.yml, runtime-independent
  plan.env = file?.env ?? {};
  plan.health = file?.healthcheck ?? null;
  plan.port = file?.port ?? null;
  plan.stack = stackOf(file);

  const procfile = text("Procfile") !== undefined ? parseProcfile(text("Procfile")!) : null;
  if (procfile) {
    const others = Object.keys(procfile).filter((k) => k !== "web" && k !== "release");
    if (others.length > 0)
      reasons.push({
        level: "warn",
        found: `Procfile: ${others.join(", ")}`,
        then: "only `web` and `release` run in a preview",
      });
  }
  plan.release = file?.release ?? procfile?.["release"] ?? null;
  if (plan.release !== null)
    reasons.push({
      level: "info",
      found: file?.release ? "release: in gangway.yml" : "Procfile release:",
      then: `runs \`${cmdText(plan.release)}\` before each version goes live`,
    });

  /** gangway.yml > Procfile web: > the runtime's own idea. */
  const startOverride = (): Command | null => {
    if (file?.start !== undefined) {
      reasons.push({
        level: "info",
        found: "start: in gangway.yml",
        then: `runs \`${cmdText(file.start)}\``,
      });
      return file.start;
    }
    if (procfile?.["web"]) {
      reasons.push({ level: "info", found: "Procfile web:", then: `runs \`${procfile["web"]}\`` });
      return procfile["web"];
    }
    return null;
  };
  const override = <T>(v: T | false | undefined, fallback: T | null): T | null =>
    v === false ? null : v === undefined ? fallback : v;
  const ignored = (keys: (keyof GangwayFile)[], why: string) => {
    const set = keys.filter((k) => file?.[k] !== undefined);
    if (set.length > 0)
      reasons.push({
        level: "warn",
        found: `${set.join(", ")} in gangway.yml`,
        then: `ignored: ${why}`,
      });
  };
  /** A build's output served by nginx. */
  const serveBuilt = (why: string, reasonFound: string) => {
    const out = file?.static === undefined || file.static === true ? null : file.static;
    plan.serve = { kind: "static", output: out, fallback: "spa" };
    plan.start = null;
    reasons.push({
      level: "info",
      found: reasonFound,
      then: `${why}serves ${out ? `${out}/` : `the build's output (${STATIC_OUTPUTS.slice(0, 3).join("/, ")}/ …)`} with nginx`,
    });
  };

  switch (runtime) {
    case "static": {
      ignored(
        ["install", "build", "start", "release", "static"],
        "the static runtime serves the files as they are (use runtime: node for a build)",
      );
      plan.release = null;
      const fallback = have.has("404.html") ? "404" : have.has("index.html") ? "spa" : "listing";
      plan.serve = { kind: "static", output: false, fallback };
      reasons.push({
        level: "info",
        found:
          fallback === "404" ? "404.html" : fallback === "spa" ? "index.html" : "no index.html",
        then:
          fallback === "404"
            ? "serves the files; 404.html for unknown paths"
            : fallback === "spa"
              ? "serves the files; index.html for unknown paths (single-page apps)"
              : "serves the files and lists directories",
      });
      break;
    }
    case "php": {
      ignored(["start", "static"], "Apache serves PHP");
      const composer = have.has("composer.json");
      plan.install = override(
        file?.install,
        composer
          ? "composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader"
          : null,
      );
      plan.build = override(file?.build, null);
      plan.docroot = file?.docroot ?? (have.has("public/index.php") ? "public" : "");
      if (composer)
        reasons.push({
          level: "info",
          found: "composer.json",
          then: `installs with \`${plan.install ? cmdText(plan.install) : "(nothing)"}\``,
        });
      reasons.push({
        level: "info",
        found: file?.docroot
          ? "docroot: in gangway.yml"
          : plan.docroot
            ? "public/index.php"
            : "PHP files at the root",
        then: `Apache serves ${plan.docroot ? `${plan.docroot}/` : "the root"}, with mod_rewrite on`,
      });
      break;
    }
    case "python": {
      ignored(["static", "docroot"], "Python runs a server");
      plan.install = override(
        file?.install,
        have.has("requirements.txt")
          ? "pip install --no-cache-dir --root-user-action=ignore -r requirements.txt"
          : have.has("pyproject.toml")
            ? "pip install --no-cache-dir --root-user-action=ignore ."
            : null,
      );
      plan.build = override(file?.build, null);
      if (plan.install)
        reasons.push({
          level: "info",
          found: have.has("requirements.txt") ? "requirements.txt" : "pyproject.toml",
          then: `installs with \`${cmdText(plan.install)}\``,
        });
      plan.start = startOverride();
      if (!plan.start) {
        const entry = firstEntry(have, rt);
        if (entry) {
          plan.start = ["python", entry];
          plan.entry = entry;
          reasons.push({
            level: "info",
            found: entry,
            then: `runs \`python ${entry}\` -- listen on $PORT, on 0.0.0.0`,
          });
        } else if (have.has("manage.py")) {
          plan.start = "python manage.py runserver 0.0.0.0:$PORT";
          reasons.push({
            level: "warn",
            found: "manage.py (Django)",
            then: "runs Django's development server; put `start: gunicorn <project>.wsgi` in gangway.yml for a real one",
          });
        } else reasons.push(noEntry(rt, " (or `start:` in gangway.yml, or a Procfile)"));
      }
      break;
    }
    case "workerd": {
      ignored(["start", "static", "docroot"], "workerd runs the bundled Worker");
      const pkg = readJson(text("package.json"), "package.json", reasons);
      plan.install = override(file?.install, pkg ? "npm install --no-audit --no-fund" : null);
      plan.build = override(file?.build, null);
      plan.entry = wranglerMain(have, text) ?? firstEntry(have, rt);
      if (plan.entry)
        reasons.push({
          level: "info",
          found: plan.entry,
          then: "bundles it with esbuild and runs it on workerd",
        });
      else reasons.push(noEntry(rt, " (or wrangler's `main`)"));
      break;
    }
    case "deno": {
      ignored(["static", "docroot"], "Deno runs a server");
      plan.install = override(file?.install, null);
      plan.build = override(file?.build, null);
      plan.start = startOverride();
      const denoJson = readJson(
        text("deno.json") ?? text("deno.jsonc"),
        have.has("deno.json") ? "deno.json" : "deno.jsonc",
        reasons,
      );
      const task = str(((denoJson?.["tasks"] ?? {}) as Json)["start"]);
      if (!plan.start && task) {
        plan.start = "deno task start";
        reasons.push({
          level: "info",
          found: "deno.json tasks.start",
          then: "runs `deno task start`",
        });
      }
      if (!plan.start) {
        plan.entry = firstEntry(have, rt);
        if (plan.entry)
          reasons.push({
            level: "info",
            found: plan.entry,
            then: "runs it; a Workers-style `export default { fetch }` is served on $PORT",
          });
        else reasons.push(noEntry(rt));
      }
      break;
    }
    case "node":
    case "bun": {
      ignored(["docroot"], "that is PHP's");
      const pkg = readJson(text("package.json"), "package.json", reasons);
      const scripts = scriptsOf(pkg);
      const pm: Pm =
        runtime === "bun"
          ? { name: "bun", install: "bun install", run: (s) => `bun run ${s}` }
          : packageManager(have);
      plan.install = override(file?.install, pkg ? pm.install : null);
      plan.build = override(file?.build, scripts["build"] !== undefined ? pm.run("build") : null);
      if (plan.install && file?.install === undefined)
        reasons.push({
          level: "info",
          found:
            pm.name === "npm"
              ? have.has("package-lock.json")
                ? "package-lock.json"
                : "package.json"
              : pm.name === "bun"
                ? "package.json"
                : `${pm.name} lockfile`,
          then: `installs with \`${cmdText(plan.install)}\``,
        });
      if (plan.build && file?.build === undefined)
        reasons.push({
          level: "info",
          found: "a build script",
          then: `runs \`${cmdText(plan.build)}\``,
        });

      if (file?.static !== undefined) {
        ignored(["start"], "static: serves files, nothing is started");
        serveBuilt(plan.build ? "builds, then " : "", "static: in gangway.yml");
        break;
      }
      plan.start = startOverride();
      if (plan.start) break;

      const start = scripts["start"];
      const isDev = start !== undefined && DEV_SERVER.test(start);
      if (start !== undefined && !(isDev && plan.build)) {
        plan.start = pm.run("start");
        reasons.push({
          level: isDev ? "warn" : "info",
          found: `"start": "${start}"`,
          then: isDev
            ? `runs \`${cmdText(plan.start)}\` -- a development server; it may refuse the preview's hostname`
            : `runs \`${cmdText(plan.start)}\``,
        });
        break;
      }
      const main =
        runtime === "bun"
          ? (entryFrom(have, pkg?.["module"]) ?? entryFrom(have, pkg?.["main"]))
          : entryFrom(have, pkg?.["main"]);
      const entry = main ?? firstEntry(have, rt);
      if (entry) {
        plan.entry = entry;
        if (runtime === "node") plan.start = ["node", entry];
        reasons.push({
          level: "info",
          found: main ? `package.json main: ${entry}` : entry,
          then:
            runtime === "node"
              ? `runs \`node ${entry}\` -- listen on $PORT`
              : `runs ${entry}; a Workers-style \`export default { fetch }\` is served on $PORT`,
        });
        break;
      }
      if (plan.build) {
        serveBuilt(
          "",
          isDev
            ? `"start" is a dev server (${start.trim().split(/\s+/)[0]}) and there is a build`
            : "a build script and nothing to start",
        );
        break;
      }
      reasons.push(
        runtime === "node" ? noEntry(rt, " (or a `start` script in package.json)") : noEntry(rt),
      );
      break;
    }
  }

  if (file?.port !== undefined && plan.serve.kind === "static")
    reasons.push({ level: "info", found: `port: ${file.port}`, then: "nginx listens there" });
  resolveAddons(plan, input, file, have);
  if (plan.addons.length > 0 && plan.serve.kind === "static")
    reasons.push({
      level: "warn",
      found: "add-ons on a static site",
      then: "nothing in a static site can connect to them",
    });
  suggestAddons(plan, text);
  return plan;
}

/** Request > gangway.yml > the previous build's > none. A major is never changed in place. */
function resolveAddons(
  plan: AppPlan,
  input: PlanInput,
  file: GangwayFile | null,
  have: Set<string>,
): void {
  const asked = input.addons ?? file?.addons ?? input.previousAddons;
  const from =
    input.addons !== undefined
      ? "asked for"
      : file?.addons !== undefined
        ? "addons: in gangway.yml"
        : "the previous build";
  const out: AddonChoice[] = [];
  for (const req of asked ?? []) {
    const id = typeof req === "string" ? req : req.id;
    const a = addonById(id);
    const prev = input.previousAddons?.find((p) => p.id === id);
    const wanted = typeof req === "string" ? undefined : req.version;
    const version = wanted ?? prev?.version ?? a.defaultVersion;
    if (a.versions[version] === undefined) {
      if (file?.addons !== undefined && input.addons === undefined)
        plan.issues.push({
          path: "addons",
          message: `${a.name} offers ${Object.keys(a.versions).join(", ")}`,
        });
      else
        plan.reasons.push({
          level: "error",
          found: `${a.name} ${version}`,
          then: `${a.name} offers ${Object.keys(a.versions).join(", ")}`,
        });
      continue;
    }
    if (prev && prev.version !== version) {
      plan.reasons.push({
        level: "error",
        found: `${a.name} ${prev.version} -> ${version}`,
        then: "a new major version needs a new preview: its data directory would not start",
      });
      continue;
    }
    out.push({ id, version });
    plan.reasons.push({
      level: "info",
      found: `${a.name} ${version} (${from})`,
      then: `a throwaway database beside the app; ${a.env[0]} in its environment; gone when the preview is`,
    });
  }
  for (const p of input.previousAddons ?? []) {
    if (!out.some((o) => o.id === p.id) && asked !== input.previousAddons) {
      plan.reasons.push({
        level: "warn",
        found: `${addonById(p.id).name} removed`,
        then: "its container goes; its data is kept until the preview is destroyed, and comes back if you add it again",
      });
    }
  }
  plan.addons = out;
  const sql = out.find((a) => isSql(a.id));
  if (sql) {
    plan.sqlSeed = addonById(sql.id).seedFiles.find((f) => have.has(f)) ?? null;
    if (plan.sqlSeed)
      plan.reasons.push({
        level: "info",
        found: plan.sqlSeed,
        then: `loaded into ${addonById(sql.id).name} on its first start only; later edits do not re-run it`,
      });
  }
}

/** Drivers in the dependencies that point at an add-on not already chosen. */
function suggestAddons(plan: AppPlan, text: (n: string) => string | undefined): void {
  const npm = new Set<string>();
  const pkgText = text("package.json");
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as Record<string, unknown>;
      for (const k of ["dependencies", "devDependencies"])
        for (const d of Object.keys(pkg[k] ?? {})) npm.add(d);
    } catch {
      /* reported by the runtime's own read */
    }
  }
  const pip = new Set<string>();
  for (const line of [text("requirements.txt") ?? "", text("pyproject.toml") ?? ""]
    .join("\n")
    .split("\n")) {
    const m = /^\s*"?([A-Za-z0-9_.-]+)/.exec(line);
    if (m) pip.add(m[1]!.toLowerCase());
  }
  const composer = new Set<string>();
  try {
    for (const d of Object.keys(
      (JSON.parse(text("composer.json") ?? "{}") as Record<string, unknown>)["require"] ?? {},
    ))
      composer.add(d);
  } catch {
    /* ignore */
  }
  for (const a of ADDONS) {
    if (plan.addons.some((c) => c.id === a.id)) continue;
    const hit =
      a.hints.npm.find((d) => npm.has(d)) ??
      a.hints.pip.find((d) => pip.has(d)) ??
      a.hints.composer.find((d) => composer.has(d));
    if (hit) plan.suggested.push({ id: a.id, because: hit });
  }
}

function stackOf(file: GangwayFile | null | undefined): AppPlan["stack"] {
  if (!file) return {};
  return {
    ...(file.ttl !== undefined ? { ttl: file.ttl } : {}),
    ...(file.visibility !== undefined ? { visibility: file.visibility } : {}),
    ...(file.idle !== undefined ? { idle: file.idle } : {}),
    ...(file.seed !== undefined ? { seed: file.seed } : {}),
  };
}

/** wrangler's `main`, from toml or json(c), read with a regex: the only key we want. */
function wranglerMain(have: Set<string>, text: (n: string) => string | undefined): string | null {
  for (const name of ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]) {
    const t = text(name);
    if (t === undefined) continue;
    const m = name.endsWith(".toml")
      ? /^\s*main\s*=\s*["']([^"'\n]+)["']/m.exec(t)
      : /"main"\s*:\s*"([^"\n]+)"/.exec(t);
    const found = entryFrom(have, m?.[1]);
    if (found) return found;
  }
  return null;
}

/** Candidate output directories for a static build, in order. Shared with the generated collect script. */
export const STATIC_BUILD_OUTPUTS: readonly string[] = STATIC_OUTPUTS;

/** Which PLAN_FILES paths a client should send contents for, given the upload's paths. */
export function planFilePaths(paths: readonly string[]): string[] {
  const names = new Set<string>(PLAN_FILES);
  return paths.filter((p) => {
    const parts = p.split("/");
    return parts.length <= 2 && names.has(parts[parts.length - 1]!);
  });
}
