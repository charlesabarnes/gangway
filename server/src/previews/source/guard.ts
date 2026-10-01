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
      if (++seen > maxEntries) {
        throw unprocessable(`the source has more than ${maxEntries} entries`);
      }
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

function list(v: unknown): unknown[] {
  if (Array.isArray(v)) {
    return v;
  }
  return v === undefined || v === null ? [] : [v];
}

/** `compose`: a compose file in its own right, read and checked in turn. */
type FileRef = { where: string; path: string; compose?: true; projectDirectory?: string };

export function referencedFiles(doc: unknown): FileRef[] {
  const d = obj(doc);
  return [
    ...includeFiles(d),
    ...Object.entries(obj(d["services"])).flatMap(([name, raw]) => serviceFiles(name, obj(raw))),
  ];
}

function includeFiles(d: Record<string, unknown>): FileRef[] {
  const out: FileRef[] = [];
  for (const inc of list(d["include"])) {
    const entry = typeof inc === "string" ? { path: inc } : obj(inc);
    const dir = entry["project_directory"];
    const projectDirectory = typeof dir === "string" ? { projectDirectory: dir } : {};
    for (const p of list(entry["path"])) {
      if (typeof p === "string") {
        out.push({ where: "include", path: p, compose: true, ...projectDirectory });
      }
    }
    for (const p of [...list(entry["env_file"]), dir]) {
      if (typeof p === "string") {
        out.push({ where: "include", path: p });
      }
    }
  }
  return out;
}

function serviceFiles(name: string, s: Record<string, unknown>): FileRef[] {
  const out: FileRef[] = [];
  for (const ef of list(s["env_file"])) {
    const p = typeof ef === "string" ? ef : obj(ef)["path"];
    if (typeof p === "string") {
      out.push({ where: `service "${name}": env_file`, path: p });
    }
  }
  for (const lf of list(s["label_file"])) {
    if (typeof lf === "string") {
      out.push({ where: `service "${name}": label_file`, path: lf });
    }
  }
  const ext = obj(s["extends"])["file"];
  if (typeof ext === "string") {
    out.push({ where: `service "${name}": extends.file`, path: ext, compose: true });
  }
  return out;
}

// compose config opens env_file, label_file, extends and include files on this machine, so every path must stay inside the tree.
export async function inspectComposeFile(srcDir: string): Promise<string | null> {
  let found: string | null = null;
  for (const name of COMPOSE_FILENAMES) {
    const st = await lstat(path.join(srcDir, name)).catch(() => null);
    if (st?.isFile()) {
      found = name;
      break;
    }
  }
  if (!found) {
    return null;
  }
  const walk = { srcDir, real: await realpath(srcDir), seen: new Set<string>() };
  await inspectOne(walk, path.join(srcDir, found), [srcDir], found);
  return found;
}

type Walk = { srcDir: string; real: string; seen: Set<string> };

// An included or extended file is read just like the top one, so its references are checked too.
const MAX_COMPOSE_FILES = 64;

// git, oci and http includes fetch a file gangway never sees; `~` is the server's home.
const remote = (p: string) =>
  /^[a-z][\w+.-]*:/i.test(p) || p.startsWith("git@") || p.startsWith("~");

async function readComposeDoc(file: string, shown: string): Promise<unknown> {
  let doc: unknown;
  try {
    doc = parseYaml(await readFile(file, "utf8"), { merge: true });
  } catch (e) {
    throw unprocessable(`${shown} is not valid YAML`, {
      detail: e instanceof Error ? e.message.slice(0, 500) : String(e),
    });
  }
  return doc;
}

/** Each place compose may resolve `ref` from: the referring file's folder and its project folder. */
function placesFor(walk: Walk, ref: FileRef, bases: readonly string[]): string[] {
  if (ref.path.includes("$")) {
    throw unprocessable(`${ref.where}: variables are not allowed in file paths`);
  }
  if (remote(ref.path)) {
    throw unprocessable(`${ref.where}: ${ref.path} is not a file in the uploaded source`);
  }
  const out = [...new Set(bases.map((b) => path.resolve(b, ref.path)))];
  if (out.some((p) => !containedIn(walk.srcDir, p))) {
    throw unprocessable(`${ref.where}: ${ref.path} is outside the uploaded source`);
  }
  return out;
}

async function inspectOne(
  walk: Walk,
  file: string,
  bases: readonly string[],
  shown: string,
): Promise<void> {
  // Through a link that stays inside, which assertNoEscapingSymlinks already promised.
  const real = await realpath(file).catch(() => null);
  if (real === null || walk.seen.has(real)) {
    return;
  }
  if (!containedIn(walk.real, real)) {
    throw unprocessable(`${shown} is outside the uploaded source`);
  }
  walk.seen.add(real);
  if (walk.seen.size > MAX_COMPOSE_FILES) {
    throw unprocessable(`the compose file includes more than ${MAX_COMPOSE_FILES} files`);
  }
  const doc = await readComposeDoc(real, shown);
  const here = [...new Set([path.dirname(file), ...bases])];
  for (const ref of referencedFiles(doc)) {
    const places = placesFor(walk, ref, here);
    if (ref.compose) {
      // An included file is its own project, with its own folder; an extended one is read in this one's.
      const next = ref.where === "include" ? projectDirs(walk, ref, here) : here;
      for (const p of places) {
        await inspectOne(walk, p, next, path.relative(walk.srcDir, p));
      }
    }
  }
}

function projectDirs(walk: Walk, ref: FileRef, here: readonly string[]): string[] {
  return ref.projectDirectory === undefined
    ? []
    : placesFor(walk, { where: ref.where, path: ref.projectDirectory }, here);
}
