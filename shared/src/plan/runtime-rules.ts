import type { RuntimeId } from "../runtimes.ts";
import { cmdText } from "./command-text.ts";
import { planNodeOrBun } from "./node-rules.ts";
import { entryFrom, readJson, str, type Json } from "./project-files.ts";
import {
  firstEntry,
  ignored,
  noEntry,
  override,
  startOverride,
  type RuleContext,
} from "./rule-context.ts";
import type { ReadFile } from "./types.ts";

export function applyRuntimeRules(ctx: RuleContext, runtime: RuntimeId): void {
  switch (runtime) {
    case "static":
      return planStatic(ctx);
    case "php":
      return planPhp(ctx);
    case "python":
      return planPython(ctx);
    case "workerd":
      return planWorkerd(ctx);
    case "deno":
      return planDeno(ctx);
    case "node":
    case "bun":
      return planNodeOrBun(ctx, runtime);
  }
}

const STATIC_FALLBACKS = {
  "404": { found: "404.html", then: "serves the files; 404.html for unknown paths" },
  spa: {
    found: "index.html",
    then: "serves the files; index.html for unknown paths (single-page apps)",
  },
  listing: { found: "no index.html", then: "serves the files and lists directories" },
} as const;

function staticFallback(have: Set<string>): keyof typeof STATIC_FALLBACKS {
  if (have.has("404.html")) return "404";
  return have.has("index.html") ? "spa" : "listing";
}

function planStatic(ctx: RuleContext): void {
  const { plan, have } = ctx;
  ignored(
    ctx,
    ["install", "build", "start", "release", "static"],
    "the static runtime serves the files as they are (use runtime: node for a build)",
  );
  plan.release = null;
  const fallback = staticFallback(have);
  plan.serve = { kind: "static", output: false, fallback };
  plan.reasons.push({ level: "info", ...STATIC_FALLBACKS[fallback] });
}

function planPhp(ctx: RuleContext): void {
  const { plan, file, have } = ctx;
  ignored(ctx, ["start", "static"], "Apache serves PHP");
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
    plan.reasons.push({
      level: "info",
      found: "composer.json",
      then: `installs with \`${plan.install ? cmdText(plan.install) : "(nothing)"}\``,
    });
  plan.reasons.push({
    level: "info",
    found: phpDocrootSource(ctx),
    then: `Apache serves ${plan.docroot ? `${plan.docroot}/` : "the root"}, with mod_rewrite on`,
  });
}

function phpDocrootSource({ plan, file }: RuleContext): string {
  if (file?.docroot) return "docroot: in gangway.yml";
  return plan.docroot ? "public/index.php" : "PHP files at the root";
}

function pythonInstall(have: Set<string>): string | null {
  if (have.has("requirements.txt"))
    return "pip install --no-cache-dir --root-user-action=ignore -r requirements.txt";
  if (have.has("pyproject.toml")) return "pip install --no-cache-dir --root-user-action=ignore .";
  return null;
}

function planPython(ctx: RuleContext): void {
  const { plan, file, have } = ctx;
  ignored(ctx, ["static", "docroot"], "Python runs a server");
  plan.install = override(file?.install, pythonInstall(have));
  plan.build = override(file?.build, null);
  if (plan.install)
    plan.reasons.push({
      level: "info",
      found: have.has("requirements.txt") ? "requirements.txt" : "pyproject.toml",
      then: `installs with \`${cmdText(plan.install)}\``,
    });
  plan.start = startOverride(ctx);
  if (!plan.start) pythonStart(ctx);
}

function pythonStart({ plan, have, rt }: RuleContext): void {
  const entry = firstEntry(have, rt);
  if (entry) {
    plan.start = ["python", entry];
    plan.entry = entry;
    plan.reasons.push({
      level: "info",
      found: entry,
      then: `runs \`python ${entry}\` -- listen on $PORT, on 0.0.0.0`,
    });
  } else if (have.has("manage.py")) {
    plan.start = "python manage.py runserver 0.0.0.0:$PORT";
    plan.reasons.push({
      level: "warn",
      found: "manage.py (Django)",
      then: "runs Django's development server; put `start: gunicorn <project>.wsgi` in gangway.yml for a real one",
    });
  } else plan.reasons.push(noEntry(rt, " (or `start:` in gangway.yml, or a Procfile)"));
}

function planWorkerd(ctx: RuleContext): void {
  const { plan, file, have, text, rt } = ctx;
  ignored(ctx, ["start", "static", "docroot"], "workerd runs the bundled Worker");
  const pkg = readJson(text("package.json"), "package.json", plan.reasons);
  plan.install = override(file?.install, pkg ? "npm install --no-audit --no-fund" : null);
  plan.build = override(file?.build, null);
  plan.entry = wranglerMain(have, text) ?? firstEntry(have, rt);
  if (plan.entry)
    plan.reasons.push({
      level: "info",
      found: plan.entry,
      then: "bundles it with esbuild and runs it on workerd",
    });
  else plan.reasons.push(noEntry(rt, " (or wrangler's `main`)"));
}

function wranglerMain(have: Set<string>, text: ReadFile): string | null {
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

function planDeno(ctx: RuleContext): void {
  const { plan, file, have, text, rt } = ctx;
  ignored(ctx, ["static", "docroot"], "Deno runs a server");
  plan.install = override(file?.install, null);
  plan.build = override(file?.build, null);
  plan.start = startOverride(ctx);
  const denoJson = readJson(
    text("deno.json") ?? text("deno.jsonc"),
    have.has("deno.json") ? "deno.json" : "deno.jsonc",
    plan.reasons,
  );
  const task = str(((denoJson?.["tasks"] ?? {}) as Json)["start"]);
  if (!plan.start && task) {
    plan.start = "deno task start";
    plan.reasons.push({
      level: "info",
      found: "deno.json tasks.start",
      then: "runs `deno task start`",
    });
  }
  if (plan.start) return;
  plan.entry = firstEntry(have, rt);
  if (plan.entry)
    plan.reasons.push({
      level: "info",
      found: plan.entry,
      then: "runs it; a Workers-style `export default { fetch }` is served on $PORT",
    });
  else plan.reasons.push(noEntry(rt));
}
