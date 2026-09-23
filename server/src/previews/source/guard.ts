import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { unprocessable } from "../../errors.ts";
import { obj } from "../../util/json.ts";
import { containedIn } from "./types.ts";

export const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

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

const list = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];

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

// compose config opens env_file, extends and include files on this machine, so every path must stay inside the tree.
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
    if (ref.path.includes("$"))
      throw unprocessable(`${ref.where}: variables are not allowed in file paths`);
    if (!containedIn(srcDir, path.resolve(srcDir, ref.path))) {
      throw unprocessable(`${ref.where}: ${ref.path} is outside the uploaded source`);
    }
  }
  return found;
}
