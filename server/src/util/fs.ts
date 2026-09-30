import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type RegularFile = { size: number; mode: number; data: Buffer | null };

/**
 * Checks and reads a regular file through one handle, so a swap between the two can't redirect the
 * read. Null when the path is missing, a symlink or not a regular file; data is null past maxBytes.
 */
export async function readRegularFile(
  file: string,
  maxBytes = Infinity,
): Promise<RegularFile | null> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
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

/** Runs a read, turning a missing file into null; any other error is thrown. */
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
