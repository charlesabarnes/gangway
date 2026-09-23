import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkFiles, packFiles } from "../../src/mcp/pack.ts";
import { extractTarball } from "../../src/previews/source/tarball.ts";
import { tempDir } from "../helpers/db.ts";

describe("files packed into a tarball", () => {
  test("the digest follows the contents, not the order they were given in", async () => {
    const a = await packFiles({ "index.html": "<h1>hi</h1>", "css/site.css": "body{}" });
    const b = await packFiles({ "css/site.css": "body{}", "index.html": "<h1>hi</h1>" });
    expect(a.digest).toBe(b.digest);
    expect(Buffer.from(a.archive).equals(Buffer.from(b.archive))).toBe(true);
    expect(
      (await packFiles({ "index.html": "<h1>ho</h1>", "css/site.css": "body{}" })).digest,
    ).not.toBe(a.digest);
    const dir = tempDir();
    await extractTarball(a.archive, dir);
    expect(readFileSync(join(dir, "css/site.css"), "utf8")).toBe("body{}");
  });

  test.each([
    ["no files", {}, "empty"],
    ["a path with ..", { "../x": "" }, "`..`"],
    ["an absolute path", { "/etc/passwd": "" }, "relative"],
    ["a path under .gangway/", { ".gangway/run.sh": "" }, ".gangway/"],
    ["a backslash", { "a\\b": "" }, "backslash"],
    ["a file over 2 MiB", { big: "x".repeat(2 * 1024 * 1024 + 1) }, "MiB"],
  ])("refuses %s", (_what, files, why) => {
    expect(() => checkFiles(files as Record<string, string>)).toThrow(why);
  });

  test("at most 1000 files", () => {
    expect(() =>
      checkFiles(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}`, ""]))),
    ).toThrow("1000");
  });
});
