import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { must } from "@gangway/shared/must";
import { unprocessable } from "../errors.ts";
import { checkEditPath } from "../previews/redeploy.ts";

const MAX_FILES = 1000;
export const MAX_BYTES = 2 * 1024 * 1024;

export function checkFiles(files: Record<string, string>): { count: number; bytes: number } {
  const entries = Object.entries(files);
  if (entries.length === 0) {
    throw unprocessable("files is empty: name at least one file, e.g. index.html");
  }
  if (entries.length > MAX_FILES) {
    throw unprocessable(`at most ${MAX_FILES} files`);
  }
  let bytes = 0;
  for (const [p, text] of entries) {
    checkEditPath(p);
    bytes += Buffer.byteLength(text, "utf8");
  }
  if (bytes > MAX_BYTES) {
    throw unprocessable(`at most ${MAX_BYTES / 1024 / 1024} MiB of file contents`);
  }
  return { count: entries.length, bytes };
}

export async function packFiles(
  files: Record<string, string>,
): Promise<{ archive: Uint8Array; digest: string }> {
  checkFiles(files);
  const paths = Object.keys(files).sort();
  const hash = createHash("sha256");
  const p = pack();
  const chunks: Buffer[] = [];
  p.on("data", (c: unknown) => {
    chunks.push(c as Buffer);
  });
  const ended = new Promise<void>((res, rej) => {
    p.on("end", res);
    p.on("error", rej);
  });
  for (const path of paths) {
    const body = Buffer.from(must(files[path], "a file's contents"), "utf8");
    hash.update(`${path}\0${body.length}\0`).update(body);
    await new Promise<void>((res, rej) =>
      p.entry({ name: path, size: body.length, mode: 0o644, mtime: new Date(0) }, body, (e) => {
        if (e) {
          rej(e);
        } else {
          res();
        }
      }),
    );
  }
  p.finalize();
  await ended;
  return {
    archive: new Uint8Array(gzipSync(Buffer.concat(chunks))),
    digest: `sha256:${hash.digest("hex")}`,
  };
}
