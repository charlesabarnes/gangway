import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUNTIMES, detectRuntime, type RuntimeId } from "@gangway/shared/runtimes";
import { planFromDisk, writeRuntime } from "../../src/previews/runtimes.ts";
import { asText } from "../../src/previews/source/store.ts";
import { tempDir } from "../helpers/db.ts";
import { folder, planned, planRuntime } from "../helpers/runtimes-fixtures.ts";

describe("detection", () => {
  test.each([
    [["compose.yaml", "package.json"], "own"],
    [["Dockerfile", "index.html"], "own"],
    [["wrangler.toml", "package.json"], "workerd"],
    [["deno.json", "main.ts"], "deno"],
    [["bun.lock", "package.json"], "bun"],
    [["package.json", "index.ts"], "node"],
    [["requirements.txt"], "python"],
    [["index.php"], "php"],
    [["index.ts"], "bun"],
    [["index.html", "style.css"], "static"],
    [[], "static"],
  ])("%j -> %s", (paths, want) => expect(detectRuntime(paths)).toBe(want as never));

  test("the server reads the same markers from disk", async () => {
    const dir = await folder({ "deno.json": "{}", "main.ts": "" });
    expect((await planFromDisk(dir, "auto")).runtime).toBe("deno");
    expect((await planFromDisk(dir, "static")).runtime).toBe("static");
  });

  test("every starter is detected as its own runtime, except deno's reads as bun", () => {
    // deno's starter is a bare main.ts; the UI posts starters with ?runtime= so this is harmless.
    for (const rt of RUNTIMES) {
      const got = detectRuntime(Object.keys(rt.starter));
      expect(got).toBe(rt.id === "deno" ? "bun" : rt.id);
    }
  });
});

describe("generated build files", () => {
  test.each([
    ["static", "nginx.conf", "listen 3000;"],
    ["php", "Dockerfile", "Listen 3000"],
    ["workerd", "bundle.cjs", "*:3000"],
  ] as [RuntimeId, string, string][])(
    "a port override reaches %s's listener",
    async (runtime, file, want) => {
      const dir = await folder({ "index.html": "", "index.php": "", "src/index.ts": "" });
      const plan = await planRuntime(dir, runtime, [], 3000);
      expect(file === "Dockerfile" ? plan.dockerfile : plan.files[file]).toContain(want);
    },
  );

  test("php without a port override does not rewrite its listener", async () => {
    const dir = await folder({ "index.php": "" });
    expect((await planRuntime(dir, "php")).dockerfile).not.toContain("sed");
  });

  test("every runtime plans a Dockerfile from its starter, FROM its pinned image", async () => {
    for (const rt of RUNTIMES) {
      const dir = await folder(rt.starter);
      const plan = await planRuntime(dir, rt.id, ["API_KEY"]);
      expect(plan.dockerfile).toContain(
        rt.id === "workerd" ? "FROM node:24-bookworm-slim" : `FROM ${rt.image}`,
      );
      expect(plan.dockerfile).toContain(`ENV PORT=${rt.port}`);
    }
  });

  test("every generated script parses", async () => {
    const ts = new Bun.Transpiler({ loader: "ts" });
    for (const rt of RUNTIMES) {
      const dir = await folder(rt.starter);
      const plan = await planRuntime(dir, rt.id, ["API_KEY", "PUBLIC_URL"]);
      for (const [name, code] of Object.entries(plan.files)) {
        if (name.endsWith(".cjs")) expect(() => new Function("require", code)).not.toThrow();
        if (name.endsWith(".ts")) expect(() => ts.transformSync(code)).not.toThrow();
      }
    }
  });

  test("a missing entry file is refused, naming the one the runtime wants", async () => {
    const dir = await folder({ "README.md": "hi" });
    await expect(planRuntime(dir, "bun")).rejects.toMatchObject({
      code: "unprocessable",
      message: expect.stringContaining("index.ts"),
    });
    await expect(planRuntime(dir, "node")).rejects.toMatchObject({
      message: expect.stringContaining("`start` script"),
    });
  });

  test("node runs the start script when there is one", async () => {
    const dir = await folder({
      "package.json": JSON.stringify({ scripts: { start: "node x.js" } }),
    });
    const plan = await planRuntime(dir, "node");
    expect(plan.dockerfile).toContain(`CMD ["/bin/sh", "/app/.gangway/start.sh"]`);
    expect(plan.files["start.sh"]).toContain("exec npm start");
  });

  test("node falls back to package.json main", async () => {
    const dir = await folder({
      "package.json": JSON.stringify({ main: "srv/app.js" }),
      "srv/app.js": "",
    });
    expect((await planRuntime(dir, "node")).files["start.sh"]).toContain(
      "exec 'node' 'srv/app.js'",
    );
  });

  test("node refuses a main that escapes the upload", async () => {
    const dir = await folder({ "package.json": JSON.stringify({ main: "../../etc/passwd" }) });
    await expect(planRuntime(dir, "node")).rejects.toMatchObject({ code: "unprocessable" });
  });

  test.each([
    [
      "an SPA fallback with index.html",
      { "index.html": "" },
      "try_files $uri $uri/ $uri.html /index.html;",
    ],
    [
      "404.html over the SPA fallback",
      { "index.html": "", "404.html": "" },
      "error_page 404 /404.html;",
    ],
    ["a listing with neither", { "a.txt": "" }, "autoindex on;"],
  ])("static serves %s", async (_what, files, want) => {
    const dir = await folder(files);
    expect((await planRuntime(dir, "static")).files["nginx.conf"]).toContain(want);
  });

  test("workerd takes wrangler's main as the entry and binds secrets by name only", async () => {
    const dir = await folder({ "wrangler.toml": 'main = "src/w.ts"\n', "src/w.ts": "" });
    const plan = await planRuntime(dir, "workerd", ["API_KEY"]);
    expect(plan.files["bundle.cjs"]).toContain('const ENTRY = "src/w.ts"');
    expect(plan.files["bundle.cjs"]).toContain('["API_KEY"]');
  });

  test("writeRuntime puts .gangway/ in the context and the compose file outside it", async () => {
    const dir = await folder({ "index.ts": "" });
    const out = tempDir();
    const { composeFile } = await writeRuntime(
      dir,
      await planned(dir, "bun"),
      { API_KEY: "s3cret" },
      join(out, "c.yaml"),
    );
    expect(existsSync(join(dir, ".gangway/Dockerfile"))).toBe(true);
    expect(existsSync(join(dir, ".gangway/entry.ts"))).toBe(true);
    expect(readFileSync(join(dir, ".gangway/Dockerfile.dockerignore"), "utf8")).toContain(
      "node_modules",
    );
    // nginx runs unprivileged and cannot read a 0600 config.
    expect(statSync(join(dir, ".gangway/Dockerfile")).mode & 0o777).toBe(0o644);
    expect(statSync(join(out, "c.yaml")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, composeFile), "utf8")).toContain("s3cret");
    expect(composeFile.startsWith("..")).toBe(true);
    await expect(
      writeRuntime(dir, await planned(dir, "bun"), {}, join(dir, "inside.yaml")),
    ).rejects.toMatchObject({ code: "internal" });
  });

  test("asText accepts UTF-8 and refuses NUL or invalid bytes", () => {
    expect(asText(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(asText(new Uint8Array([0x68, 0, 0x69]))).toBeNull();
    expect(asText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});
