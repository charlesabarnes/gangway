import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppPlan } from "@gangway/shared/app-plan";
import { unprocessable } from "../errors.ts";
import { dotenvLine } from "../secrets/secrets.ts";
import type { RenderedAddons } from "./addons.ts";
import { composeForDockerfile } from "./compose-generate.ts";
import type { PreviewContext } from "./context.ts";
import { stackX } from "./runtimes.ts";
import { COMPOSE_FILENAMES, inspectComposeFile } from "./source/guard.ts";
import { GENERATED_DIR } from "./source/store.ts";
import { DIR_MODE, FILE_MODE } from "./source/types.ts";

export const COMPOSE_FILE = "compose.yaml";

async function writeDotenv(srcDir: string, env: Record<string, string>): Promise<number> {
  const names = Object.keys(env);
  if (names.length === 0) return 0;
  const file = join(srcDir, ".env");
  const st = await lstat(file).catch(() => null);
  if (st && !st.isFile()) throw unprocessable(".env in the source is not a regular file");
  const committed = st ? await Bun.file(file).text() : "";
  const lines = names.map((k) => dotenvLine(k, env[k]!));
  const body = `${committed.replace(/\s*$/, "")}${committed.trim() === "" ? "" : "\n"}# --- gangway: repository secrets ---\n${lines.join("\n")}\n`;
  await writeFile(file, body, { mode: 0o600 });
  return names.length;
}

async function requireDockerfilePort(
  srcDir: string,
  askedPort: number | undefined,
  plan: AppPlan | null,
): Promise<number> {
  const dockerfile = await lstat(join(srcDir, "Dockerfile")).catch(() => null);
  if (!dockerfile?.isFile()) {
    throw unprocessable(
      `the source has no compose file (${COMPOSE_FILENAMES.join(", ")}) and no Dockerfile at its root -- or choose a runtime to build it with`,
    );
  }
  const port = askedPort ?? plan?.port ?? undefined;
  if (port === undefined) {
    throw unprocessable(
      "the source has a Dockerfile but no compose file, so `port` is required: the port the app listens on inside the container (`port:` in gangway.yml, or ?port=)",
    );
  }
  return port;
}

export async function ownStack(
  ctx: PreviewContext,
  id: string,
  srcDir: string,
  env: Record<string, string> | undefined,
  askedPort: number | undefined,
  plan: AppPlan | null,
  sidecars?: RenderedAddons,
): Promise<string> {
  if (env) {
    const n = await writeDotenv(srcDir, env);
    if (n > 0)
      ctx.logs.append(id, "system", `wrote .env with ${n} repository secret${n === 1 ? "" : "s"}`);
  }
  const found = await inspectComposeFile(srcDir);
  if (found) return found;

  const port = await requireDockerfilePort(srcDir, askedPort, plan);
  if (sidecars) {
    await mkdir(join(srcDir, GENERATED_DIR), { recursive: true, mode: DIR_MODE });
    for (const [name, body] of Object.entries(sidecars.files))
      await writeFile(join(srcDir, GENERATED_DIR, name), body, { mode: FILE_MODE });
  }
  const appEnv = { ...(plan?.env ?? {}), ...(sidecars?.appEnv ?? {}) };
  await writeFile(
    join(srcDir, COMPOSE_FILE),
    composeForDockerfile({
      port,
      env: appEnv,
      health: plan?.health,
      sidecars,
      ...(plan ? { stack: stackX(plan) } : {}),
    }),
    { mode: 0o600 },
  );
  return COMPOSE_FILE;
}
