import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AppPlan } from "@gangway/shared/app-plan";
import type { Preview, PreviewState } from "@gangway/shared/domain";
import { runtimeById } from "@gangway/shared/runtimes";
import { AppError, badRequest, unprocessable } from "../errors.ts";
import { compress, compressible } from "../net/encode.ts";
import { ENCODED_DIR } from "../net/site.ts";
import { compareCodeUnits } from "../util/compare.ts";
import { isUlid } from "../util/ulid.ts";
import { artifactIndex, kitConfig, renderAssets } from "./artifact-render.ts";
import type { PreviewContext } from "./context.ts";
import type { Planned } from "./stack-file.ts";
import { sensitiveName } from "./sensitive.ts";
import { GENERATED_DIR } from "./source/store.ts";
import { containedIn, DIR_MODE, FILE_MODE } from "./source/types.ts";

/** Left out of a site, as the container build leaves them out of its context. */
export const SKIPPED = new Set([".git", "node_modules", GENERATED_DIR]);

export type SiteFallback = "spa" | "404";

/** What the file server needs besides the files: written beside them as site.json. */
export type SiteMeta = {
  fallback: SiteFallback;
  /** Serve the kit at /_gangway/, as an artifact's page loads it from there. */
  kit: boolean;
  theme?: string | null;
  kind?: string | undefined;
};

export type Site = SiteMeta & { root: string; dir: string };

/** A plan gangway can serve as files: the static runtime, nothing to build, run or attach. */
export function servable(plan: AppPlan | undefined): plan is AppPlan & {
  serve: { kind: "static"; fallback: SiteFallback };
} {
  return (
    plan?.kind === "runtime" &&
    plan.runtime === "static" &&
    plan.serve.kind === "static" &&
    plan.serve.output === false &&
    plan.serve.fallback !== "listing" &&
    plan.install === null &&
    plan.build === null &&
    plan.start === null &&
    plan.release === null &&
    plan.stack.seed === undefined &&
    plan.addons.length === 0
  );
}

const TOWARDS_AWAKE: Partial<Record<PreviewState, PreviewState>> = {
  failed: "building",
  building: "starting",
  asleep: "starting",
  starting: "awake",
};

/** Walk a preview whose files were just published to awake, through the states a start takes. */
export function markServing(ctx: Pick<PreviewContext, "previews" | "states">, id: string): Preview {
  let p = ctx.previews.get(id);
  while (p && p.state !== "awake") {
    const next = TOWARDS_AWAKE[p.state];
    if (!next) {
      throw new AppError("conflict", `preview ${id} is ${p.state}`);
    }
    p = ctx.states.transition(id, next);
  }
  if (!p) {
    throw new AppError("not_found", `no such preview: ${id}`);
  }
  return p;
}

/** Whether this deploy's files go to gangway's file server instead of a container. */
export function servesHere(
  ctx: Pick<PreviewContext, "sites" | "sources" | "serveStatic">,
  plan: AppPlan | undefined,
): boolean {
  return (
    ctx.sites !== undefined &&
    ctx.sources !== undefined &&
    (ctx.serveStatic?.() ?? true) &&
    servable(plan)
  );
}

/** The stack it would have been, without asking compose, so its route comes out the same. */
export function siteModel(plan: AppPlan, port: number | undefined): Planned {
  const listen = port ?? plan.port ?? runtimeById("static").port;
  return {
    model: {
      services: [
        {
          name: "web",
          image: null,
          hasBuild: true,
          publishedTargets: [],
          exposed: [listen],
          x: { expose: true, port: listen },
        },
      ],
      networks: ["default"],
      volumes: [],
      x: { ...plan.stack },
      violations: [],
    },
    resolved: null,
  };
}

/** `withheld`: what was left out as sensitive (sensitive.ts), for the deploy's log. */
export type Copied = { files: number; bytes: number; withheld: string[] };

const WITHHELD_SHOWN = 10;

/** The log line that says what publish left out, or null when it left nothing out. */
export function withheldLine(withheld: readonly string[]): string | null {
  if (withheld.length === 0) {
    return null;
  }
  const shown = withheld.toSorted(compareCodeUnits).slice(0, WITHHELD_SHOWN).join(", ");
  const more =
    withheld.length > WITHHELD_SHOWN ? ` and ${withheld.length - WITHHELD_SHOWN} more` : "";
  return `not published, as they may hold secrets: ${shown}${more} (use gangway secrets instead)`;
}

/** The bytes of the regular files under `dir`, links not followed; `kept` keeps publish's rules. */
export async function dirBytes(dir: string, kept = false): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (kept && (SKIPPED.has(e.name) || sensitiveName(e.name, e.isDirectory()))) {
      continue;
    }
    const at = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirBytes(at, kept);
    } else if (e.isFile()) {
      total += Bun.file(at).size;
    }
  }
  return total;
}

async function copyFiles(from: string, to: string, rel = ""): Promise<Copied> {
  const out: Copied = { files: 0, bytes: 0, withheld: [] };
  await mkdir(to, { recursive: true, mode: DIR_MODE });
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (SKIPPED.has(e.name)) {
      continue;
    }
    const at = rel ? `${rel}/${e.name}` : e.name;
    if (sensitiveName(e.name, e.isDirectory())) {
      out.withheld.push(e.isDirectory() ? `${at}/` : at);
      continue;
    }
    const src = path.join(from, e.name);
    const dest = path.join(to, e.name);
    if (e.isDirectory()) {
      const sub = await copyFiles(src, dest, at);
      out.files += sub.files;
      out.bytes += sub.bytes;
      out.withheld.push(...sub.withheld);
    } else if (e.isFile()) {
      await copyFile(src, dest);
      out.files++;
      out.bytes += Bun.file(dest).size;
    }
  }
  return out;
}

/** Writes a .br and a .gz of each compressible file under `from` into the same place under `to`. */
async function encodeFiles(from: string, to: string): Promise<void> {
  for (const e of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    if (e.isDirectory()) {
      await encodeFiles(src, path.join(to, e.name));
      continue;
    }
    if (!e.isFile()) {
      continue;
    }
    const { size } = await stat(src);
    if (!compressible(Bun.file(src).type, size)) {
      continue;
    }
    const data = await Bun.file(src).bytes();
    const [br, gz] = await Promise.all([compress(data, "br"), compress(data, "gzip")]);
    await mkdir(to, { recursive: true, mode: DIR_MODE });
    await writeFile(path.join(to, `${e.name}.br`), br, { mode: FILE_MODE });
    await writeFile(path.join(to, `${e.name}.gz`), gz, { mode: FILE_MODE });
  }
}

export class SiteStore {
  readonly #root: string;
  readonly #open = new Map<string, Site | null>();

  constructor(stateDir: string) {
    this.#root = path.resolve(stateDir, "sites");
  }

  dirFor(previewId: string): string {
    if (!isUlid(previewId)) {
      throw badRequest("invalid preview id");
    }
    return path.join(this.#root, previewId);
  }

  /** Build the site from a planned upload beside the live one, then swap it in. */
  async publish(previewId: string, srcDir: string, plan: AppPlan): Promise<Copied> {
    if (!servable(plan)) {
      throw unprocessable("this upload needs a container to serve it");
    }
    const from = plan.root ? path.join(srcDir, plan.root) : srcDir;
    if (!containedIn(srcDir, from)) {
      throw unprocessable("root: leaves the upload");
    }

    const dest = this.dirFor(previewId);
    const next = `${dest}.next`;
    const old = `${dest}.old`;
    await mkdir(this.#root, { recursive: true, mode: DIR_MODE });
    await rm(next, { recursive: true, force: true });
    const copied = await copyFiles(from, path.join(next, "root"));

    const meta: SiteMeta = {
      fallback: plan.serve.fallback,
      kit: plan.artifact !== null,
      ...(plan.artifact?.theme ? { theme: plan.artifact.theme } : {}),
      ...(plan.artifact ? { kind: plan.artifact.kind } : {}),
    };
    if (plan.artifact?.format === "markdown") {
      const html = artifactIndex(plan.artifact, renderAssets().version);
      await writeFile(path.join(next, "root", "index.html"), html, { mode: FILE_MODE });
    }
    await writeFile(path.join(next, "site.json"), JSON.stringify(meta), { mode: FILE_MODE });
    if (meta.kit) {
      await writeFile(path.join(next, "kit-config.json"), kitConfig(), { mode: FILE_MODE });
    }
    await encodeFiles(path.join(next, "root"), path.join(next, ENCODED_DIR));

    await rm(old, { recursive: true, force: true });
    if (await this.has(previewId)) {
      await rename(dest, old);
    }
    await rename(next, dest);
    this.#open.delete(previewId);
    await rm(old, { recursive: true, force: true });
    return { ...copied, bytes: await dirBytes(dest) };
  }

  async has(previewId: string): Promise<boolean> {
    return (await lstat(this.dirFor(previewId)).catch(() => null))?.isDirectory() ?? false;
  }

  /** The site as the file server reads it, or null when it is missing or unreadable. */
  async open(previewId: string): Promise<Site | null> {
    const hit = this.#open.get(previewId);
    if (hit !== undefined) {
      return hit;
    }
    const dir = this.dirFor(previewId);
    let site: Site | null = null;
    try {
      const meta = JSON.parse(await readFile(path.join(dir, "site.json"), "utf8")) as SiteMeta;
      site = { ...meta, dir, root: path.join(dir, "root") };
    } catch {
      // Not a site (or not yet): remembered as such until publish or remove.
    }
    this.#open.set(previewId, site);
    return site;
  }

  async remove(previewId: string): Promise<void> {
    const dir = this.dirFor(previewId);
    this.#open.delete(previewId);
    await Promise.all(
      [dir, `${dir}.next`, `${dir}.old`].map((d) => rm(d, { recursive: true, force: true })),
    );
  }

  async ids(): Promise<string[]> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() && isUlid(e.name)).map((e) => e.name);
  }
}

export function plannedBytes(srcDir: string, plan: AppPlan): Promise<number> {
  return dirBytes(plan.root ? path.join(srcDir, plan.root) : srcDir, true);
}
