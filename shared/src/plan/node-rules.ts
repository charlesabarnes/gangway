import { cmdText } from "./command-text.ts";
import { entryFrom, readJson, type Json } from "./project-files.ts";
import {
  firstEntry,
  ignored,
  noEntry,
  override,
  serveBuilt,
  startOverride,
  type RuleContext,
} from "./rule-context.ts";

const DEV_COMMANDS = [
  String.raw`vite(?:\s+dev)?`,
  String.raw`next\s+dev`,
  String.raw`nuxt\s+dev`,
  String.raw`ng\s+serve`,
  String.raw`react-scripts\s+start`,
  String.raw`vue-cli-service\s+serve`,
  String.raw`astro\s+dev`,
  String.raw`svelte-kit\s+dev`,
  String.raw`webpack(?:-dev-server|\s+serve)`,
  String.raw`parcel(?!\s+build)`,
].join("|");
const DEV_SERVER = new RegExp(String.raw`^\s*(?:npx\s+)?(?:${DEV_COMMANDS})(?:\s|$)`);

type Pm = {
  install: string;
  run: (script: string) => string;
  source: string;
};

const BUN: Pm = { install: "bun install", run: (s) => `bun run ${s}`, source: "package.json" };

function packageManager(have: Set<string>): Pm {
  if (have.has("pnpm-lock.yaml")) {
    return {
      install: "corepack enable && pnpm install --frozen-lockfile",
      run: (s) => `pnpm run ${s}`,
      source: "pnpm lockfile",
    };
  }
  if (have.has("yarn.lock")) {
    return {
      install: "corepack enable && yarn install",
      run: (s) => `yarn run ${s}`,
      source: "yarn lockfile",
    };
  }
  const locked = have.has("package-lock.json") || have.has("npm-shrinkwrap.json");
  return {
    install: locked ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund",
    run: (s) => (s === "start" ? "npm start" : `npm run ${s}`),
    source: have.has("package-lock.json") ? "package-lock.json" : "package.json",
  };
}

const scriptsOf = (pkg: Json | null): Record<string, string> =>
  Object.fromEntries(
    Object.entries((pkg?.["scripts"] ?? {}) as Json).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;

export function planNodeOrBun(ctx: RuleContext, runtime: "node" | "bun"): void {
  const { plan, file, have, text, rt } = ctx;
  ignored(ctx, ["docroot"], "that is PHP's");
  const pkg = readJson(text("package.json"), "package.json", plan.reasons);
  const scripts = scriptsOf(pkg);
  const pm = runtime === "bun" ? BUN : packageManager(have);
  installAndBuild(ctx, pm, pkg, scripts);

  if (file?.static !== undefined) {
    ignored(ctx, ["start"], "static: serves files, nothing is started");
    serveBuilt(ctx, plan.build ? "builds, then " : "", "static: in gangway.yml");
    return;
  }
  plan.start = startOverride(ctx);
  if (plan.start) {
    return;
  }

  const start = scripts["start"];
  const isDev = start !== undefined && DEV_SERVER.test(start);
  if (start !== undefined && !(isDev && plan.build)) {
    runStartScript(ctx, pm, start, isDev);
    return;
  }
  if (runEntry(ctx, runtime, pkg)) {
    return;
  }
  if (plan.build) {
    serveBuilt(
      ctx,
      "",
      isDev
        ? `"start" is a dev server (${start.trim().split(/\s+/)[0]}) and there is a build`
        : "a build script and nothing to start",
    );
    return;
  }
  plan.reasons.push(
    runtime === "node" ? noEntry(rt, " (or a `start` script in package.json)") : noEntry(rt),
  );
}

function installAndBuild(
  { plan, file }: RuleContext,
  pm: Pm,
  pkg: Json | null,
  scripts: Record<string, string>,
): void {
  plan.install = override(file?.install, pkg ? pm.install : null);
  plan.build = override(file?.build, scripts["build"] !== undefined ? pm.run("build") : null);
  if (plan.install && file?.install === undefined) {
    plan.reasons.push({
      level: "info",
      found: pm.source,
      then: `installs with \`${cmdText(plan.install)}\``,
    });
  }
  if (plan.build && file?.build === undefined) {
    plan.reasons.push({
      level: "info",
      found: "a build script",
      then: `runs \`${cmdText(plan.build)}\``,
    });
  }
}

function runStartScript({ plan }: RuleContext, pm: Pm, start: string, isDev: boolean): void {
  plan.start = pm.run("start");
  plan.reasons.push({
    level: isDev ? "warn" : "info",
    found: `"start": "${start}"`,
    then: isDev
      ? `runs \`${cmdText(plan.start)}\` -- a development server; it may refuse the preview's hostname`
      : `runs \`${cmdText(plan.start)}\``,
  });
}

function runEntry({ plan, have, rt }: RuleContext, runtime: "node" | "bun", pkg: Json | null) {
  const main =
    runtime === "bun"
      ? (entryFrom(have, pkg?.["module"]) ?? entryFrom(have, pkg?.["main"]))
      : entryFrom(have, pkg?.["main"]);
  const entry = main ?? firstEntry(have, rt);
  if (!entry) {
    return false;
  }
  plan.entry = entry;
  if (runtime === "node") {
    plan.start = ["node", entry];
  }
  plan.reasons.push({
    level: "info",
    found: main ? `package.json main: ${entry}` : entry,
    then:
      runtime === "node"
        ? `runs \`node ${entry}\` -- listen on $PORT`
        : `runs ${entry}; a Workers-style \`export default { fetch }\` is served on $PORT`,
  });
  return true;
}
