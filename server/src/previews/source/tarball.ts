/**
 * Streaming tarball extraction (§5.1, the agent upload path).
 *
 * The archive is attacker-controlled: an agent posts it, and nothing upstream has looked
 * inside. So it is never buffered to disk and re-read, never handed to `tar(1)`, and every
 * limit is enforced against bytes as they arrive rather than against a header field the
 * archive itself supplied. A gzip bomb must die a few hundred kilobytes in, not after it
 * has filled the state volume.
 */
import { chmod, lstat, mkdir, open, realpath, symlink, link } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { extract, type Extract, type ExtractEvents } from "tar-stream";
import { AppError, errorMessage } from "../../errors.ts";
import {
  DIR_MODE,
  FILE_MODE,
  containedIn,
  rejectTarball,
  resolveLimits,
  resolveWithin,
  type ExtractLimits,
  type ExtractResult,
  type ResolvedLimits,
} from "./types.ts";

/** tar-stream exports the entry stream only through its event map. */
type TarEntry = ExtractEvents["entry"][1];

export type TarballSource = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

type Context = {
  dest: string;
  limits: ResolvedLimits;
  /** Directories already created and proven to be real directories, not symlinks. */
  dirs: Set<string>;
  result: ExtractResult;
};

export async function extractTarball(
  source: TarballSource | Promise<TarballSource>,
  destDir: string,
  limits: ExtractLimits = {},
): Promise<ExtractResult> {
  const resolved = resolveLimits(limits);
  await mkdir(destDir, { recursive: true });
  // Resolve once: macOS hands out /var/... symlinks for temp dirs, and every containment
  // check below compares against this string.
  const dest = await realpath(destDir);

  const ctx: Context = {
    dest,
    limits: resolved,
    dirs: new Set([dest]),
    result: { entries: 0, files: 0, directories: 0, links: 0, totalBytes: 0 },
  };

  const ex = extract();
  let feedError: unknown;

  const feed = (async () => {
    try {
      for await (const chunk of decompressed(await source)) {
        if (ex.destroyed) return;
        ctx.result.totalBytes += chunk.byteLength;
        if (ctx.result.totalBytes > resolved.maxTotalBytes) {
          throw rejectTarball(
            "archive_too_large",
            `archive exceeds ${resolved.maxTotalBytes} decompressed bytes`,
          );
        }
        if (!ex.write(chunk)) await writable(ex);
      }
      ex.end(null);
    } catch (err) {
      // Hand the reason to the consumer: destroying the extract stream makes the
      // `for await` below throw, which is how a mid-stream abort surfaces.
      feedError = err;
      ex.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  try {
    for await (const entry of ex) {
      ctx.result.entries++;
      if (ctx.result.entries > resolved.maxEntries) {
        throw rejectTarball("too_many_entries", `archive exceeds ${resolved.maxEntries} entries`);
      }
      await handleEntry(ctx, entry);
    }
    return ctx.result;
  } catch (err) {
    throw asTarballError(feedError ?? err);
  } finally {
    if (!ex.destroyed) ex.destroy();
    await feed;
  }
}

async function handleEntry(ctx: Context, entry: TarEntry): Promise<void> {
  const name = entry.header.name ?? "";

  // Cheap string checks first: a hostile name should never reach the filesystem layer.
  if (name.includes("\u0000"))
    throw rejectTarball("invalid_path", "entry path contains a NUL byte", name);
  if (name.length === 0) throw rejectTarball("invalid_path", "entry path is empty");
  if (Buffer.byteLength(name) > ctx.limits.maxPathBytes) {
    throw rejectTarball(
      "path_too_long",
      `entry path exceeds ${ctx.limits.maxPathBytes} bytes`,
      name,
    );
  }
  if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) {
    throw rejectTarball("absolute_path", "entry path is absolute", name);
  }

  const segments = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw rejectTarball("path_traversal", "entry path contains a '..' segment", name);
  }

  const type = entry.header.type ?? "file";

  // "./" and "" after normalisation mean the archive root, which already exists.
  if (segments.length === 0) {
    if (type !== "directory")
      throw rejectTarball("invalid_path", "entry path resolves to the root", name);
    ctx.result.directories++;
    return;
  }

  const target = resolveWithin(ctx.dest, segments.join("/"));
  if (target === undefined)
    throw rejectTarball("path_escape", "entry path escapes the destination", name);

  switch (type) {
    case "directory":
      await ensureDir(ctx, target);
      ctx.result.directories++;
      return;
    case "file":
    case "contiguous-file":
      await writeFileEntry(ctx, entry, target);
      ctx.result.files++;
      return;
    case "symlink":
    case "link":
      await writeLinkEntry(ctx, entry, target, type);
      ctx.result.links++;
      return;
    default:
      throw rejectTarball("unsupported_entry_type", `unsupported entry type '${type}'`, name);
  }
}

async function writeFileEntry(ctx: Context, entry: TarEntry, target: string): Promise<void> {
  await ensureDir(ctx, path.dirname(target));

  // "wx" is O_EXCL: it refuses to follow or clobber anything already at this path, which
  // is what stops a later entry from writing through a symlink an earlier one planted.
  const handle = await open(target, "wx", FILE_MODE).catch((err: unknown) => {
    if (isErrno(err, "EEXIST")) {
      throw rejectTarball("duplicate_entry", "two entries claim the same path", entry.header.name);
    }
    throw err;
  });

  try {
    let bytes = 0;
    for await (const chunk of entry as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > ctx.limits.maxFileBytes) {
        throw rejectTarball(
          "file_too_large",
          `file exceeds ${ctx.limits.maxFileBytes} bytes`,
          entry.header.name,
        );
      }
      await handle.write(chunk);
    }
    await handle.chmod(FILE_MODE);
  } finally {
    await handle.close();
  }
}

async function writeLinkEntry(
  ctx: Context,
  entry: TarEntry,
  target: string,
  type: "symlink" | "link",
): Promise<void> {
  const linkname = entry.header.linkname ?? "";
  if (linkname.length === 0 || linkname.includes("\u0000")) {
    throw rejectTarball(
      "invalid_path",
      "link target is empty or contains a NUL byte",
      entry.header.name,
    );
  }

  // A hardlink target is relative to the archive root; a symlink target is relative to the
  // link's own directory. Either way it has to land inside the destination.
  const base = type === "link" ? ctx.dest : path.dirname(target);
  const resolvedTarget = path.isAbsolute(linkname) ? linkname : path.resolve(base, linkname);
  if (!containedIn(ctx.dest, resolvedTarget)) {
    throw rejectTarball(
      "link_escape",
      `${type} target escapes the destination`,
      `${entry.header.name} -> ${linkname}`,
    );
  }

  await ensureDir(ctx, path.dirname(target));
  try {
    if (type === "symlink") await symlink(linkname, target);
    else await link(resolvedTarget, target);
  } catch (err) {
    if (isErrno(err, "EEXIST")) {
      throw rejectTarball("duplicate_entry", "two entries claim the same path", entry.header.name);
    }
    throw err;
  }
}

/**
 * Creates each level itself rather than leaning on `mkdir -p`, because every level has to
 * be proven a real directory: a symlinked component would silently redirect the write,
 * and `mkdir` follows symlinks without complaint.
 */
async function ensureDir(ctx: Context, dir: string): Promise<void> {
  if (ctx.dirs.has(dir)) return;

  let current = ctx.dest;
  for (const segment of path.relative(ctx.dest, dir).split(path.sep)) {
    current = path.join(current, segment);
    if (ctx.dirs.has(current)) continue;

    await mkdir(current, { mode: DIR_MODE }).catch((err: unknown) => {
      if (!isErrno(err, "EEXIST")) throw err;
    });

    const st = await lstat(current);
    if (st.isSymbolicLink()) {
      throw rejectTarball(
        "path_escape",
        "path component is a symlink",
        path.relative(ctx.dest, current),
      );
    }
    if (!st.isDirectory()) {
      throw rejectTarball(
        "duplicate_entry",
        "path component is not a directory",
        path.relative(ctx.dest, current),
      );
    }

    await chmod(current, DIR_MODE);
    ctx.dirs.add(current);
  }
}

/** Resolves when the stream will accept more bytes, or when it has been torn down. */
function writable(ex: Extract): Promise<void> {
  if (ex.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      ex.off("drain", done);
      ex.off("close", done);
      ex.off("error", done);
      resolve();
    };
    ex.on("drain", done);
    ex.on("close", done);
    ex.on("error", done);
  });
}

/** Sniffs the gzip magic on the first chunk; everything downstream counts inflated bytes. */
async function* decompressed(source: TarballSource): AsyncGenerator<Uint8Array> {
  const bytes = iterate(source);
  const first = await bytes.next();
  if (first.done) return;

  const head = first.value;
  const all = prepend(head, bytes);
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    // node:zlib, not DecompressionStream: macOS's bsdtar pads what it writes to a pipe with
    // zeros to a 10240-byte record AFTER the gzip stream (`tar -czf - . | curl`), and
    // DecompressionStream fails that as "inflate failed" where zlib stops at the member's end.
    const src = Readable.from(all);
    const gz = createGunzip();
    src.on("error", (e) => gz.destroy(e));
    src.pipe(gz);
    try {
      for await (const chunk of gz) yield chunk as Uint8Array;
    } finally {
      src.destroy();
      gz.destroy();
    }
    return;
  }
  yield* all;
}

async function* iterate(source: TarballSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  for await (const chunk of source as AsyncIterable<Uint8Array>) yield chunk;
}

async function* prepend(
  head: Uint8Array,
  rest: AsyncGenerator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield head;
  yield* rest;
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/**
 * Anything that is not already a classified rejection is the archive's fault, not ours:
 * a truncated stream, a bad gzip trailer, a header tar-stream cannot parse.
 */
function asTarballError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  const message = errorMessage(err);
  return rejectTarball("malformed_archive", `could not read the archive: ${message}`);
}
