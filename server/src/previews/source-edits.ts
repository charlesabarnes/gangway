import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unprocessable } from "../errors.ts";
import { GENERATED_DIR } from "./source/store.ts";
import { DIR_MODE, FILE_MODE, resolveWithin } from "./source/types.ts";

export type SourceEdits = Record<string, string | null>;

export function checkEditPath(p: string): string {
  const bad = (why: string) =>
    unprocessable(`cannot write ${JSON.stringify(p.slice(0, 200))}: ${why}`);
  if (p.length === 0 || p.length > 255) throw bad("a path is 1-255 characters");
  if (p.includes("\0") || p.includes("\\")) throw bad("no NUL or backslash");
  if (p.startsWith("/")) throw bad("paths are relative to the upload's root");
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".."))
    throw bad("no empty, `.` or `..` segments");
  if (parts.includes(GENERATED_DIR)) throw bad(`${GENERATED_DIR}/ is written by gangway`);
  return p;
}

async function assertWritable(srcDir: string, rel: string): Promise<void> {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const st = await lstat(join(srcDir, ...parts.slice(0, i))).catch(() => null);
    if (st?.isSymbolicLink())
      throw unprocessable(
        `cannot write ${JSON.stringify(rel)}: ${parts.slice(0, i).join("/")} is a symlink`,
      );
    if (st && i < parts.length && !st.isDirectory())
      throw unprocessable(
        `cannot write ${JSON.stringify(rel)}: ${parts.slice(0, i).join("/")} is a file`,
      );
    if (st && i === parts.length && st.isDirectory())
      throw unprocessable(`cannot write ${JSON.stringify(rel)}: it is a directory`);
  }
}

export async function applyEdits(srcDir: string, files: SourceEdits): Promise<number> {
  let n = 0;
  for (const [rel, text] of Object.entries(files)) {
    checkEditPath(rel);
    const abs = resolveWithin(srcDir, rel);
    if (!abs) throw unprocessable(`cannot write ${JSON.stringify(rel)}: it leaves the upload`);
    await assertWritable(srcDir, rel);
    if (text === null) {
      await rm(abs, { force: true });
    } else {
      await mkdir(dirname(abs), { recursive: true, mode: DIR_MODE });
      await writeFile(abs, text, { mode: FILE_MODE });
    }
    n++;
  }
  return n;
}
