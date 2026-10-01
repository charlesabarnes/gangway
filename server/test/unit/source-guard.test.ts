import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoEscapingSymlinks,
  inspectComposeFile,
  referencedFiles,
} from "../../src/previews/source/guard.ts";
import { tempDir } from "../helpers/db.ts";

const tree = (files: Record<string, string> = {}) => {
  const dir = realpathSync(tempDir());
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
};

describe("assertNoEscapingSymlinks", () => {
  test("links inside the tree are fine, at any depth", async () => {
    const dir = tree({ "a/real.txt": "x" });
    symlinkSync("real.txt", join(dir, "a/alias.txt"));
    symlinkSync(join(dir, "a"), join(dir, "abs-but-inside"));
    await expect(assertNoEscapingSymlinks(dir)).resolves.toBeUndefined();
  });

  test.each([
    ["an absolute path", "/etc/passwd"],
    ["the process environment", "/proc/self/environ"],
    ["a relative climb", "../../../../etc/hosts"],
    ["nothing (dangling)", "./does-not-exist"],
  ])("a link to %s is refused, and named", async (_what, target) => {
    const dir = tree({ "src/app.js": "x" });
    symlinkSync(target, join(dir, "src/.env"));
    await expect(assertNoEscapingSymlinks(dir)).rejects.toMatchObject({
      code: "unprocessable",
      message: expect.stringContaining("src/.env"),
    });
  });

  test("a link chain that ends outside is refused even though its first hop is inside", async () => {
    const dir = tree();
    symlinkSync("/etc", join(dir, "hop2"));
    symlinkSync("hop2/hosts", join(dir, "hop1"));
    await expect(assertNoEscapingSymlinks(dir)).rejects.toMatchObject({ code: "unprocessable" });
  });

  test("a bomb of entries is refused rather than walked forever", async () => {
    const dir = tree({ a: "", b: "", c: "" });
    await expect(assertNoEscapingSymlinks(dir, 2)).rejects.toThrow("more than 2 entries");
  });
});

describe("referencedFiles", () => {
  test("finds every file `compose config` would open, in every spelling", () => {
    expect(
      referencedFiles({
        include: [
          "a.yaml",
          { path: ["b.yaml", "c.yaml"], env_file: "inc.env", project_directory: "sub" },
        ],
        services: {
          web: {
            env_file: [".env.web", { path: "opt.env", required: false }],
            extends: { file: "base.yaml", service: "x" },
          },
          db: { env_file: "db.env", label_file: ["db.labels"] },
        },
      }).map((r) => r.path),
    ).toEqual([
      "a.yaml",
      "b.yaml",
      "c.yaml",
      "inc.env",
      "sub",
      ".env.web",
      "opt.env",
      "base.yaml",
      "db.env",
      "db.labels",
    ]);
    expect(referencedFiles(null)).toEqual([]);
    expect(referencedFiles({ services: { web: { extends: { service: "same-file" } } } })).toEqual(
      [],
    );
  });
});

describe("inspectComposeFile", () => {
  test("prefers compose.yaml, accepts the legacy names, and reports none as null", async () => {
    expect(
      await inspectComposeFile(
        tree({ "compose.yaml": "services: {}", "docker-compose.yml": "services: {}" }),
      ),
    ).toBe("compose.yaml");
    expect(await inspectComposeFile(tree({ "docker-compose.yml": "services: {}" }))).toBe(
      "docker-compose.yml",
    );
    expect(await inspectComposeFile(tree({ Dockerfile: "FROM scratch" }))).toBeNull();
  });

  test("references inside the source are fine", async () => {
    const dir = tree({
      "compose.yaml": "services:\n  web:\n    image: nginx\n    env_file: [config/web.env]\n",
      "config/web.env": "A=1",
    });
    expect(await inspectComposeFile(dir)).toBe("compose.yaml");
  });

  test.each([
    ["env_file: /proc/self/environ", 'service "web": env_file'],
    ["env_file: ../../gangway.db", 'service "web": env_file'],
    ["extends: { file: /etc/compose-base.yaml, service: x }", 'service "web": extends.file'],
    ["env_file: ${HOME}/.aws/credentials", "variables are not allowed"],
  ])("`%s` is refused before compose ever runs", async (line, where) => {
    const dir = tree({ "compose.yaml": `services:\n  web:\n    image: nginx\n    ${line}\n` });
    await expect(inspectComposeFile(dir)).rejects.toMatchObject({
      code: "unprocessable",
      message: expect.stringContaining(where),
    });
  });

  test("an out-of-tree include is refused; broken YAML is a 422 that says so", async () => {
    await expect(
      inspectComposeFile(
        tree({ "compose.yaml": "include:\n  - ../other/compose.yaml\nservices: {}\n" }),
      ),
    ).rejects.toThrow("outside the uploaded source");
    await expect(
      inspectComposeFile(tree({ "compose.yaml": "services: [unclosed" })),
    ).rejects.toMatchObject({
      code: "unprocessable",
      message: expect.stringContaining("not valid YAML"),
    });
  });

  test.each([
    [
      "an included file's env_file",
      "include: [sub/inc.yaml]\nservices: {}\n",
      "sub/inc.yaml",
      "services:\n  db:\n    image: x\n    env_file: ../../../etc/passwd\n",
    ],
    [
      "an included file's own include",
      "include: [sub/inc.yaml]\nservices: {}\n",
      "sub/inc.yaml",
      "include: [/etc/compose.yaml]\n",
    ],
    [
      "an extended file's extends",
      "services:\n  web:\n    extends: { file: base.yaml, service: b }\n",
      "base.yaml",
      "services:\n  b:\n    image: x\n    extends: { file: /etc/base.yaml, service: c }\n",
    ],
    [
      "an extended file's label_file",
      "services:\n  web:\n    extends: { file: base.yaml, service: b }\n",
      "base.yaml",
      "services:\n  b:\n    image: x\n    label_file: /proc/self/environ\n",
    ],
  ])("%s outside the source is refused", async (_, top, name, nested) => {
    await expect(inspectComposeFile(tree({ "compose.yaml": top, [name]: nested }))).rejects.toThrow(
      "outside the uploaded source",
    );
  });

  test("a path that only escapes from the include's project_directory is refused", async () => {
    const dir = tree({
      "compose.yaml":
        "include:\n  - path: a/inc.yaml\n    project_directory: a/b/c\nservices: {}\n",
      "a/inc.yaml": "services:\n  db:\n    image: x\n    env_file: ../../../../x.env\n",
    });
    await expect(inspectComposeFile(dir)).rejects.toThrow("outside the uploaded source");
  });

  test.each([
    "oci://docker.io/x/y:1",
    "git@github.com:x/y.git",
    "https://example.com/c.yaml",
    "~/c.yaml",
  ])("a remote include `%s` is refused", async (p) => {
    await expect(
      inspectComposeFile(tree({ "compose.yaml": `include: ["${p}"]\nservices: {}\n` })),
    ).rejects.toThrow("not a file in the uploaded source");
  });

  test("nested files inside the source are fine, cycles included", async () => {
    const dir = tree({
      "compose.yaml":
        "include: [sub/inc.yaml]\nservices:\n  web:\n    extends: { file: sub/inc.yaml, service: db }\n",
      "sub/inc.yaml":
        "include: [../compose.yaml]\nservices:\n  db:\n    image: x\n    env_file: db.env\n",
      "sub/db.env": "A=1",
    });
    expect(await inspectComposeFile(dir)).toBe("compose.yaml");
  });

  test("a compose.yaml that is itself a symlink is not a compose file", async () => {
    const dir = tree();
    symlinkSync("/etc/hosts", join(dir, "compose.yaml"));
    expect(await inspectComposeFile(dir)).toBeNull();
  });
});
