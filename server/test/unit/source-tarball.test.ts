import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  lstat,
  readlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pack, type Header } from "tar-stream";
import { extractTarball } from "../../src/previews/source/tarball.ts";
import {
  TarballError,
  containedIn,
  resolveWithin,
  type TarballRejection,
} from "../../src/previews/source/types.ts";
import { Workdirs } from "../../src/previews/source/workdir.ts";
import { AppError } from "../../src/errors.ts";

/** tar-stream writes PAX records for anything the ustar header itself cannot hold. */
type PackHeader = Partial<Header> & { name: string };
type Entry = { header: PackHeader; body?: string };

async function tarBytes(entries: Entry[]): Promise<Uint8Array> {
  const p = pack();
  for (const e of entries) p.entry(e.header, e.body ?? "");
  p.finalize();
  const chunks: Uint8Array[] = [];
  for await (const c of p) chunks.push(c as Uint8Array);
  return Buffer.concat(chunks);
}

/** Every fixture here is hostile; it never lands anywhere but a fresh dir under os.tmpdir(). */
const tmpdirs: string[] = [];
async function scratch(): Promise<string> {
  // macOS hands out /var/folders/..., a symlink to /private/var; resolve it so that the
  // paths the extractor reports can be compared with the ones the test built.
  const d = await mkdtemp(path.join(await realpath(os.tmpdir()), "gw-tar-"));
  tmpdirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of tmpdirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function expectReject(
  fn: () => Promise<unknown>,
  reason: TarballRejection,
): Promise<TarballError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TarballError);
  const err = caught as TarballError;
  expect(err.reason).toBe(reason);
  return err;
}

const gzip = (b: Uint8Array): ReadableStream<Uint8Array> =>
  new Blob([b]).stream().pipeThrough(new CompressionStream("gzip"));

describe("containment guard", () => {
  // The bug this whole module exists to avoid: a prefix match is not a path match.
  test("a sibling directory sharing a name prefix is not contained", () => {
    expect("/tmp/foobar".startsWith("/tmp/foo")).toBe(true); // the naive check says yes
    expect(containedIn("/tmp/foo", "/tmp/foobar")).toBe(false);
    expect(containedIn("/tmp/foo", "/tmp/foobar/x.txt")).toBe(false);
  });

  test("the directory itself and its children are contained", () => {
    expect(containedIn("/tmp/foo", "/tmp/foo")).toBe(true);
    expect(containedIn("/tmp/foo", "/tmp/foo/a/b")).toBe(true);
    expect(containedIn("/tmp/foo/", "/tmp/foo/a")).toBe(true);
  });

  test("resolveWithin refuses an escape and accepts a nested path", () => {
    expect(resolveWithin("/tmp/foo", "../foobar/x")).toBeUndefined();
    expect(resolveWithin("/tmp/foo", "a/b.txt")).toBe("/tmp/foo/a/b.txt");
  });
});

describe("extractTarball happy path", () => {
  test("extracts a normal archive with correct content and modes", async () => {
    const dest = await scratch();
    const bytes = await tarBytes([
      { header: { name: "pkg", type: "directory", mode: 0o777 } },
      { header: { name: "pkg/index.js", mode: 0o777 }, body: "console.log(1)\n" },
      { header: { name: "pkg/nested/deep.txt", mode: 0o600 }, body: "deep" },
    ]);

    const result = await extractTarball(bytes, dest);

    expect(await readFile(path.join(dest, "pkg/index.js"), "utf8")).toBe("console.log(1)\n");
    expect(await readFile(path.join(dest, "pkg/nested/deep.txt"), "utf8")).toBe("deep");
    expect(result.files).toBe(2);
    expect(result.entries).toBe(3);
    expect(result.totalBytes).toBeGreaterThan(0);

    // The archive asked for 0777 and 0600; it does not get to decide.
    expect((await stat(path.join(dest, "pkg/index.js"))).mode & 0o7777).toBe(0o644);
    expect((await stat(path.join(dest, "pkg/nested/deep.txt"))).mode & 0o7777).toBe(0o644);
    expect((await stat(path.join(dest, "pkg"))).mode & 0o7777).toBe(0o755);
    expect((await stat(path.join(dest, "pkg/nested"))).mode & 0o7777).toBe(0o755);
  });

  test("accepts a gzipped archive arriving as a web ReadableStream", async () => {
    const dest = await scratch();
    const bytes = await tarBytes([{ header: { name: "a.txt" }, body: "gz" }]);
    const result = await extractTarball(gzip(bytes), dest);
    expect(await readFile(path.join(dest, "a.txt"), "utf8")).toBe("gz");
    expect(result.files).toBe(1);
  });

  test("accepts gzip padded with zeros to a 10240-byte record, as macOS bsdtar writes to a pipe (`tar -czf - . | curl`)", async () => {
    const dest = await scratch();
    const compressed = new Uint8Array(
      await new Response(
        gzip(await tarBytes([{ header: { name: "a.txt" }, body: "padded" }])),
      ).arrayBuffer(),
    );
    const padded = new Uint8Array(10240);
    padded.set(compressed);
    expect((await extractTarball(padded, dest)).files).toBe(1);
    expect(await readFile(path.join(dest, "a.txt"), "utf8")).toBe("padded");
  });

  test("a corrupt gzip stream is still the archive's fault", async () => {
    const dest = await scratch();
    const compressed = new Uint8Array(
      await new Response(
        gzip(await tarBytes([{ header: { name: "a.txt" }, body: "x".repeat(4000) }])),
      ).arrayBuffer(),
    );
    compressed.fill(0x55, 12, 40);
    await expectReject(() => extractTarball(compressed, dest), "malformed_archive");
  });

  test("creates the destination directory if it does not exist", async () => {
    const parent = await scratch();
    const dest = path.join(parent, "does", "not", "exist");
    await extractTarball(await tarBytes([{ header: { name: "a.txt" }, body: "x" }]), dest);
    expect(await readFile(path.join(dest, "a.txt"), "utf8")).toBe("x");
  });

  test("keeps a symlink whose target stays inside the destination", async () => {
    const dest = await scratch();
    const result = await extractTarball(
      await tarBytes([
        { header: { name: "real.txt" }, body: "real" },
        { header: { name: "alias.txt", type: "symlink", linkname: "real.txt" } },
      ]),
      dest,
    );
    expect(result.links).toBe(1);
    expect((await lstat(path.join(dest, "alias.txt"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(dest, "alias.txt"))).toBe("real.txt");
  });
});

describe("extractTarball rejects hostile archives", () => {
  test("a path with traversal segments", async () => {
    const dest = await scratch();
    await expectReject(
      () =>
        extractTarball(tarBytes([{ header: { name: "../../escaped.txt" }, body: "pwned" }]), dest),
      "path_traversal",
    );
    await expectReject(
      () =>
        extractTarball(
          tarBytes([{ header: { name: "a/b/../../../out.txt" }, body: "pwned" }]),
          dest,
        ),
      "path_traversal",
    );
    expect(await readdir(dest)).toEqual([]);
  });

  test("an absolute path", async () => {
    const dest = await scratch();
    await expectReject(
      () => extractTarball(tarBytes([{ header: { name: "/etc/cron.d/pwned" }, body: "x" }]), dest),
      "absolute_path",
    );
  });

  test("a symlink pointing outside the destination", async () => {
    const dest = await scratch();
    await expectReject(
      () =>
        extractTarball(
          tarBytes([{ header: { name: "passwd", type: "symlink", linkname: "/etc/passwd" } }]),
          dest,
        ),
      "link_escape",
    );
    await expectReject(
      () =>
        extractTarball(
          tarBytes([{ header: { name: "up", type: "symlink", linkname: "../../../etc" } }]),
          dest,
        ),
      "link_escape",
    );
  });

  test("a hardlink pointing outside the destination", async () => {
    const dest = await scratch();
    await expectReject(
      () =>
        extractTarball(
          tarBytes([{ header: { name: "shadow", type: "link", linkname: "../outside.txt" } }]),
          dest,
        ),
      "link_escape",
    );
  });

  /**
   * The trailing-separator rule, end to end: "<tmp>/foobar" must not pass as a child of
   * "<tmp>/foo" just because the string starts the same way.
   */
  test("a link target in a sibling directory sharing a name prefix", async () => {
    const base = await scratch();
    const dest = path.join(base, "foo");
    const sibling = path.join(base, "foobar");
    await mkdir(dest, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, "secret.txt"), "secret");

    await expectReject(
      () =>
        extractTarball(
          tarBytes([
            { header: { name: "leak", type: "symlink", linkname: "../foobar/secret.txt" } },
          ]),
          dest,
        ),
      "link_escape",
    );
    expect(await readdir(dest)).toEqual([]);
  });

  /**
   * The two-step escape: plant a symlink that passes the target check, then write through
   * it. Every path component has to be a real directory, not just resolve to one.
   */
  test("a file written through a symlinked directory component", async () => {
    const dest = await scratch();
    await expectReject(
      () =>
        extractTarball(
          tarBytes([
            { header: { name: "real", type: "directory" } },
            { header: { name: "alias", type: "symlink", linkname: "real" } },
            { header: { name: "alias/planted.txt" }, body: "pwned" },
          ]),
          dest,
        ),
      "path_escape",
    );
    expect(await readdir(path.join(dest, "real"))).toEqual([]);
  });

  test("entry types other than file and directory", async () => {
    for (const type of ["character-device", "block-device", "fifo"] as const) {
      const dest = await scratch();
      await expectReject(
        () => extractTarball(tarBytes([{ header: { name: `dev-${type}`, type } }]), dest),
        "unsupported_entry_type",
      );
    }
  });

  test("more entries than maxEntries", async () => {
    const dest = await scratch();
    const entries = Array.from({ length: 12 }, (_, i) => ({
      header: { name: `f${i}.txt` },
      body: "x",
    }));
    await expectReject(
      () => extractTarball(tarBytes(entries), dest, { maxEntries: 5 }),
      "too_many_entries",
    );
    expect((await readdir(dest)).length).toBeLessThanOrEqual(5);
  });

  test("a single file over maxFileBytes", async () => {
    const dest = await scratch();
    await expectReject(
      () =>
        extractTarball(tarBytes([{ header: { name: "big.bin" }, body: "x".repeat(5000) }]), dest, {
          maxFileBytes: 1024,
        }),
      "file_too_large",
    );
  });

  test("total decompressed bytes over maxTotalBytes, aborted mid-stream", async () => {
    const dest = await scratch();
    // 60 x 64KiB of highly compressible padding: tiny on the wire, 3.8MiB once inflated.
    const entries = Array.from({ length: 60 }, (_, i) => ({
      header: { name: `pad-${i}.bin` },
      body: "0".repeat(64 * 1024),
    }));
    const bytes = await tarBytes(entries);
    const compressed = await new Response(gzip(bytes)).arrayBuffer();
    expect(compressed.byteLength).toBeLessThan(bytes.byteLength / 10); // it really is a bomb

    await expectReject(
      () => extractTarball(gzip(bytes), dest, { maxTotalBytes: 256 * 1024 }),
      "archive_too_large",
    );

    // Aborted mid-stream, not after inflating all of it: most entries never reach the disk.
    expect((await readdir(dest)).length).toBeLessThan(entries.length / 2);
  });

  test("a path longer than 255 bytes", async () => {
    const dest = await scratch();
    const long = `${"a".repeat(120)}/${"b".repeat(150)}.txt`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(255);
    await expectReject(
      () => extractTarball(tarBytes([{ header: { name: long }, body: "x" }]), dest),
      "path_too_long",
    );
  });

  test("a path that only exceeds 255 once encoded", async () => {
    const dest = await scratch();
    const name = "é".repeat(200); // 200 characters, 400 bytes
    expect(name.length).toBeLessThan(255);
    await expectReject(
      () => extractTarball(tarBytes([{ header: { name }, body: "x" }]), dest),
      "path_too_long",
    );
  });

  test("a path containing a NUL byte", async () => {
    const dest = await scratch();
    // The ustar name field is NUL-terminated, so a NUL can only arrive via a PAX record.
    const bytes = await tarBytes([
      { header: { name: "ok.txt", pax: { path: "evil\u0000.txt" } }, body: "x" },
    ]);
    await expectReject(() => extractTarball(bytes, dest), "invalid_path");
  });

  test("two entries writing the same path", async () => {
    const dest = await scratch();
    await expectReject(
      () =>
        extractTarball(
          tarBytes([
            { header: { name: "dup.txt" }, body: "first" },
            { header: { name: "dup.txt" }, body: "second" },
          ]),
          dest,
        ),
      "duplicate_entry",
    );
  });

  test("a file entry landing on a path already taken by a symlink", async () => {
    const dest = await scratch();
    await expectReject(
      () =>
        extractTarball(
          tarBytes([
            { header: { name: "target.txt" }, body: "harmless" },
            { header: { name: "alias", type: "symlink", linkname: "target.txt" } },
            { header: { name: "alias" }, body: "written through the link" },
          ]),
          dest,
        ),
      "duplicate_entry",
    );
    expect(await readFile(path.join(dest, "target.txt"), "utf8")).toBe("harmless");
  });

  test("truncated archive bytes", async () => {
    const dest = await scratch();
    const bytes = await tarBytes([{ header: { name: "a.txt" }, body: "x".repeat(4096) }]);
    await expectReject(() => extractTarball(bytes.slice(0, 700), dest), "malformed_archive");
  });
});

/**
 * Workdirs has no test file of its own; it is exercised here because the only thing that
 * ever writes into a workdir is the extractor.
 */
describe("Workdirs", () => {
  test("creates a private per-deploy directory and extracts into it", async () => {
    const state = await scratch();
    const workdirs = new Workdirs(state);
    const workdir = await workdirs.create("01JAAAAAAAAAAAAAAAAAAAAAAA");

    expect(workdir.dir.startsWith(path.join(state, "work") + path.sep)).toBe(true);
    expect((await stat(workdir.dir)).mode & 0o7777).toBe(0o700);

    await extractTarball(
      await tarBytes([{ header: { name: "app.js" }, body: "ok" }]),
      workdir.srcDir,
    );
    expect(await readFile(path.join(workdir.srcDir, "app.js"), "utf8")).toBe("ok");

    await workdir.cleanup();
    expect(await stat(workdir.dir).catch(() => null)).toBeNull();
  });

  test("create wipes whatever a crashed run left behind", async () => {
    const workdirs = new Workdirs(await scratch());
    const first = await workdirs.create("deploy-1");
    await writeFile(path.join(first.srcDir, "stale.txt"), "from the last attempt");

    const second = await workdirs.create("deploy-1");
    expect(second.dir).toBe(first.dir);
    expect(await readdir(second.srcDir)).toEqual([]);
  });

  test("cleanup is idempotent and safe on an id that never existed", async () => {
    const workdirs = new Workdirs(await scratch());
    const workdir = await workdirs.create("deploy-2");
    await workdir.cleanup();
    await workdir.cleanup();
    await workdirs.remove("never-created");
  });

  test("with() removes the directory even when the body throws", async () => {
    const workdirs = new Workdirs(await scratch());
    let seen = "";
    await expect(
      workdirs.with("deploy-3", async (w) => {
        seen = w.dir;
        throw new Error("build blew up");
      }),
    ).rejects.toThrow("build blew up");
    expect(await stat(seen).catch(() => null)).toBeNull();
  });

  test("prune clears everything left over from a previous process", async () => {
    const workdirs = new Workdirs(await scratch());
    await workdirs.create("deploy-a");
    await workdirs.create("deploy-b");
    expect((await workdirs.prune()).sort()).toEqual(["deploy-a", "deploy-b"]);
    expect(await readdir(workdirs.root)).toEqual([]);
  });

  test("refuses an id that would escape the work root", async () => {
    const workdirs = new Workdirs(await scratch());
    for (const id of ["../escape", "a/b", "", ".", "/abs"]) {
      expect(() => workdirs.pathFor(id)).toThrow(AppError);
    }
  });
});
