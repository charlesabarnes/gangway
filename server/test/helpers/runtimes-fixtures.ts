import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { pack } from "tar-stream";
import type { RuntimeId } from "@gangway/shared/runtimes";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { runtimeRoutes, schemaRoutes } from "../../src/app/routes/runtimes.ts";
import { deploy } from "../../src/previews/deploy.ts";
import type { DeployInput } from "../../src/previews/deploy-types.ts";
import { redeploy } from "../../src/previews/redeploy.ts";
import { assertRunnable, planFromDisk, type RuntimeChoice } from "../../src/previews/runtimes.ts";
import { renderRuntime } from "../../src/previews/runtime-dockerfile.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { tempDir } from "./db.ts";
import { silentLogger } from "./logger.ts";
import { ACTOR, setupPreviewContext } from "./preview-context.ts";

/** Plan an upload on disk as a runtime and render its build files: what a deploy does. */
export async function planRuntime(
  dir: string,
  id: RuntimeId,
  bindings: string[] = [],
  port?: number,
) {
  const plan = await planFromDisk(dir, id);
  assertRunnable(plan);
  return renderRuntime(plan, bindings, port);
}

export async function planned(dir: string, choice: RuntimeChoice = "auto") {
  const p = await planFromDisk(dir, choice);
  assertRunnable(p);
  return p;
}

export async function tarball(files: Record<string, string>): Promise<Uint8Array> {
  const p = pack();
  for (const [name, content] of Object.entries(files)) p.entry({ name }, content);
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const c of p) chunks.push(c as Buffer);
  return gzipSync(Buffer.concat(chunks));
}

/** A temp directory holding these files. */
export async function folder(files: Record<string, string>): Promise<string> {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** The harness with a kept-source store, as boot wires it. */
export function setupRuntimes() {
  const s = setupPreviewContext();
  const stateDir = dirname(s.ctx.workdirs.root);
  s.ctx.sources = new SourceStore(stateDir);
  return { ...s, sources: s.ctx.sources, stateDir };
}
export type RuntimesHarness = ReturnType<typeof setupRuntimes>;

/** Deploy these files as a public tarball preview. */
export async function deployFiles(
  s: RuntimesHarness,
  files: Record<string, string>,
  runtime: RuntimeChoice = "auto",
  name?: string,
) {
  const input: DeployInput = {
    actor: ACTOR,
    visibility: "public",
    source: { kind: "tarball", archive: await tarball(files), runtime },
    ...(name === undefined ? {} : { name }),
  };
  return deploy(s.ctx, input);
}

/** Redeploy with an edit and wait for the outcome. */
export async function edit(s: RuntimesHarness, previewId: string, files: Record<string, string>) {
  return (await redeploy(s.ctx, { actor: ACTOR, previewId, change: { kind: "edit", files } })).done;
}

/** The preview and runtime routes, signed in as ACTOR. */
export function runtimesApi(s: RuntimesHarness) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(silentLogger()));
  app.use(async (c, next) => {
    c.set("requestId", "r");
    c.set("actor", ACTOR);
    return next();
  });
  previewRoutes(app, s.ctx, null as never);
  runtimeRoutes(app);
  schemaRoutes(app);
  return app;
}
