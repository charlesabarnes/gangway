import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type RegularFile = { size: number; mode: number; data: Buffer | null };

/** Checked and read through one handle; null for a missing path, a link or a non-file. */
export async function readRegularFile(
  file: string,
  maxBytes = Infinity,
): Promise<RegularFile | null> {
  const fh = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (!fh) {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      return null;
    }
    const data = st.size > maxBytes ? null : await fh.readFile();
    return { size: st.size, mode: st.mode & 0o777, data };
  } finally {
    await fh.close();
  }
}

export function readIfExists<T>(read: () => T): T | null {
  try {
    return read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw e;
  }
}
