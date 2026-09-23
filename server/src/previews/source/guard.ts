/**
 * What must be true of an unpacked source before `docker compose config` is allowed to
 * read it. `config` is not a parser: it opens files. `env_file`, `extends.file` and
 * `include` are all read on this machine, merged into the output, and then vanish from
 * it -- so the policy in compose-model.ts, which sees only the output, cannot catch them.
 *
 *   env_file: /proc/self/environ     -> gangway's environment, as the container's
 *   .env -> ../../gangway.db         -> a symlink in a git checkout does the same thing
 *
 * So: no symlink may leave the tree, and every path the compose file names must stay
 * inside it.
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { AppError } from "../../errors.ts";
import { containedIn } from "./types.ts";

const unprocessable = (m: string, d?: Record<string, unknown>) =>
  new AppError("unprocessable", m, d);

export const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

/** Every symlink must resolve to something inside `root`. Dangling links are refused too. */
export async function assertNoEscapingSymlinks(root: string, maxEntries = 200_000): Promise<void> {
  const real = await realpath(root);
  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (++seen > maxEntries)
        throw unprocessable(`the source has more than ${maxEntries} entries`);
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = await realpath(p).catch(() => null);
        if (target === null || !containedIn(real, target)) {
          throw unprocessable(
            `the source contains a symlink that leaves the source tree: ${path.relative(root, p)}`,
          );
        }
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  };
  await walk(root);
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];

/** The file paths a raw compose document asks `config` to open, with where each was found. */
export function referencedFiles(doc: unknown): { where: string; path: string }[] {
  const out: { where: string; path: string }[] = [];
  const d = obj(doc);
  for (const inc of list(d["include"])) {
    const paths =
      typeof inc === "string"
        ? [inc]
        : [
            ...list(obj(inc)["path"]),
            ...list(obj(inc)["env_file"]),
            ...list(obj(inc)["project_directory"]),
          ];
    for (const p of paths) if (typeof p === "string") out.push({ where: "include", path: p });
  }
  for (const [name, raw] of Object.entries(obj(d["services"]))) {
    const s = obj(raw);
    for (const ef of list(s["env_file"])) {
      const p = typeof ef === "string" ? ef : obj(ef)["path"];
      if (typeof p === "string") out.push({ where: `service "${name}": env_file`, path: p });
    }
    const ext = obj(s["extends"])["file"];
    if (typeof ext === "string") out.push({ where: `service "${name}": extends.file`, path: ext });
  }
  return out;
}

/**
 * Finds the compose file in `srcDir` and checks every file it references. Returns the
 * file's name, or null when the source has none (the caller may synthesize one).
 */
export async function inspectComposeFile(srcDir: string): Promise<string | null> {
  let found: string | null = null;
  for (const name of COMPOSE_FILENAMES) {
    const st = await lstat(path.join(srcDir, name)).catch(() => null);
    if (st?.isFile()) {
      found = name;
      break;
    }
  }
  if (!found) return null;

  let doc: unknown;
  try {
    doc = parseYaml(await readFile(path.join(srcDir, found), "utf8"), { merge: true });
  } catch (e) {
    throw unprocessable(`${found} is not valid YAML`, {
      detail: e instanceof Error ? e.message.slice(0, 500) : String(e),
    });
  }
  for (const ref of referencedFiles(doc)) {
    // `${VAR}` in a path is interpolated by compose after this check could see it.
    if (ref.path.includes("$"))
      throw unprocessable(`${ref.where}: variables are not allowed in file paths`);
    if (!containedIn(srcDir, path.resolve(srcDir, ref.path))) {
      throw unprocessable(`${ref.where}: ${ref.path} is outside the uploaded source`);
    }
  }
  return found;
}
