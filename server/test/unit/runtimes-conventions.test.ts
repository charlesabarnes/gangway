import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeRuntime } from "../../src/previews/runtimes.ts";
import { tempDir } from "../helpers/db.ts";
import {
  deployFiles,
  edit,
  folder,
  planned,
  planRuntime,
  setupRuntimes,
} from "../helpers/runtimes-fixtures.ts";

const parses = (script: string | undefined) =>
  Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script) }).exitCode === 0;

describe("build conventions and scripts", () => {
  test("upload-supplied commands stay out of the Dockerfile and are quoted in scripts", async () => {
    const evil = 'echo $(id) `x` "; RUN rm -rf /';
    const dir = await folder({
      "package.json": JSON.stringify({ scripts: { build: evil, start: "node s.js" } }),
      "gangway.yml": 'env: { NOTE: "it\'s $HOME" }\nstart: [node, "s p a c e.js", "it\'s"]\n',
      "s p a c e.js": "",
    });
    const r = await planRuntime(dir, "node");
    expect(r.dockerfile).not.toContain("id)");
    expect(r.dockerfile).not.toContain("rm -rf");
    expect(r.dockerfile).toContain(`RUN ["/bin/sh", ".gangway/build.sh"]`);
    expect(r.files["build.sh"]).toContain("npm run build");
    expect(r.files["build.sh"]).toContain(`export NOTE='it'\\''s $HOME'`);
    expect(r.files["start.sh"]).toContain(`exec 'node' 's p a c e.js' 'it'\\''s'`);
    // The start script's environment is the container's: no exports that would shadow a secret.
    expect(r.files["start.sh"]).not.toContain("export");
    for (const [name, body] of Object.entries(r.files))
      if (name.endsWith(".sh")) expect(parses(body)).toBe(true);
  });

  test("a compound start command runs as written, with no exec dropping the rest", async () => {
    const dir = await folder({
      "gangway.yml": "runtime: python\nstart: python migrate.py && exec python app.py\n",
    });
    expect((await planRuntime(dir, "python")).files["start.sh"]).toContain(
      "\npython migrate.py && exec python app.py\n",
    );
  });

  test("a Vite app is built by node and served by nginx on the runtime's port", async () => {
    const dir = await folder({
      "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
      "index.html": "",
    });
    const r = await planRuntime(dir, "node");
    expect(r.dockerfile).toContain("FROM node:24-alpine AS build");
    expect(r.dockerfile).toContain(`RUN ["/bin/sh", ".gangway/collect-static.sh"]`);
    expect(r.dockerfile).toContain("FROM nginxinc/nginx-unprivileged:1.29-alpine");
    expect(r.dockerfile).toContain("COPY --from=build /out/ /usr/share/nginx/html/");
    expect(r.files["nginx.conf"]).toContain("listen 3000;");
    expect(r.files["collect-static.sh"]).toContain(
      "for d in 'dist' 'build' 'out' '.output/public' dist/*/browser; do",
    );
    expect(parses(r.files["collect-static.sh"])).toBe(true);
  });

  test("collect-static.sh finds the build output, and fails when there is none", async () => {
    const dir = await folder({ "package.json": JSON.stringify({ scripts: { build: "x" } }) });
    const script = (await planRuntime(dir, "node")).files["collect-static.sh"]!.replaceAll(
      "/out",
      join(dir, "out-copy"),
    );
    await writeFile(join(dir, "collect.sh"), script);
    expect(Bun.spawnSync(["sh", "collect.sh"], { cwd: dir }).exitCode).toBe(1);
    await mkdir(join(dir, "dist/app/browser"), { recursive: true });
    await writeFile(join(dir, "dist/app/browser/index.html"), "<h1>ng</h1>");
    expect(Bun.spawnSync(["sh", "collect.sh"], { cwd: dir }).exitCode).toBe(0);
    expect(readFileSync(join(dir, "out-copy/index.html"), "utf8")).toBe("<h1>ng</h1>");
  });

  test("php installs with composer and serves from public/", async () => {
    const dir = await folder({ "composer.json": "{}", "public/index.php": "" });
    const r = await planRuntime(dir, "php");
    expect(r.dockerfile).toContain(
      "COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer",
    );
    expect(r.dockerfile).toContain(`ENV APACHE_DOCUMENT_ROOT="/var/www/html/public"`);
    expect(r.dockerfile).toContain("a2enmod rewrite");
    expect(r.files["install.sh"]).toContain("composer install --no-dev");
  });

  test("a version from gangway.yml picks the pinned image", async () => {
    const dir = await folder({ "gangway.yml": 'version: "3.12"\n', "main.py": "" });
    expect((await planRuntime(dir, "python")).dockerfile).toContain("FROM python:3.12-slim");
  });

  test("a nested app builds from its own directory, with policy and health in compose", async () => {
    const dir = await folder({
      "README.md": "",
      "site/gangway.yml": "healthcheck: /up\nttl: 3d\nrelease: echo migrate\nenv: { MODE: demo }\n",
      "site/index.ts": "",
    });
    const out = tempDir();
    const plan = await planned(dir);
    expect(plan.root).toBe("site");
    const { composeFile } = await writeRuntime(
      dir,
      plan,
      { MODE: "secret-wins" },
      join(out, "c.yaml"),
    );
    expect(existsSync(join(dir, "site/.gangway/Dockerfile"))).toBe(true);
    expect(existsSync(join(dir, ".gangway"))).toBe(false);
    const doc = JSON.parse(readFileSync(join(dir, composeFile), "utf8"));
    expect(doc["x-gangway"]).toEqual({ ttl: "3d", release: "echo migrate" });
    expect(doc.services.web.build).toEqual({ context: "site", dockerfile: ".gangway/Dockerfile" });
    expect(doc.services.web["x-gangway"]).toEqual({ expose: true, port: 3000, health: "/up" });
    expect(doc.services.web.environment.MODE).toBe("secret-wins");
  });
});

describe("gangway.yml in a deploy", () => {
  test("release runs before seed, the health path is probed, and the plan is logged", async () => {
    const s = setupRuntimes();
    const paths: (string | undefined)[] = [];
    s.ctx.probe = async (_r, _h, path) => {
      paths.push(path);
      return true;
    };
    const res = await deployFiles(s, {
      "index.ts": "export default {}",
      "gangway.yml": "release: npm run migrate\nseed: npm run seed\nhealthcheck: /ready\n",
    });
    expect((await res.done).state).toBe("awake");
    expect(s.fake.runs.map((a) => a.at(-1))).toEqual(["npm run migrate", "npm run seed"]);
    expect(paths).toContain("/ready");
    const log = s.ctx.logs.read(res.preview.id).map((l) => l.line);
    expect(log.some((l) => l.startsWith("plan: index.ts -> looks like TypeScript on Bun"))).toBe(
      true,
    );
    expect((await s.sources.list(res.preview.id)).files.map((f) => f.path)).toEqual([
      "gangway.yml",
      "index.ts",
    ]);
  });

  test("a bad gangway.yml is a 422 naming the key, and nothing is kept", async () => {
    const s = setupRuntimes();
    await expect(
      deployFiles(s, { "index.ts": "", "gangway.yml": "strat: x\n" }),
    ).rejects.toMatchObject({
      code: "unprocessable",
      message: expect.stringContaining("gangway.yml:"),
      detail: { issues: [expect.objectContaining({ path: "" })] },
    });
    expect(await s.sources.ids()).toEqual([]);
  });

  test("a lone Dockerfile gets its port from gangway.yml", async () => {
    const s = setupRuntimes();
    const res = await deployFiles(s, { Dockerfile: "FROM nginx", "gangway.yml": "port: 8081\n" });
    await res.done;
    expect(s.routes.forPreview(res.preview.id)[0]).toMatchObject({ containerPort: 8081 });
  });

  test("a rebuild runs the release first, and a failed release keeps the old version", async () => {
    const s = setupRuntimes();
    const p = await (await deployFiles(s, { "index.ts": "v1" }, "bun", "rel")).done;
    s.fake.runExit = 1;
    const o = await edit(s, p.id, { "gangway.yml": "release: npm run migrate\n" });
    expect(o).toMatchObject({ outcome: "failed", preview: { state: "awake" } });
    expect(s.fake.runs.at(-1)!.at(-1)).toBe("npm run migrate");
    expect(s.ctx.logs.read(p.id).map((l) => l.line)).toContain(
      "rebuild FAILED: compose run (release) exited 1 -- the previous version is still serving",
    );
  });

  test("a rebuild keeps the recorded runtime unless gangway.yml names another", async () => {
    const s = setupRuntimes();
    const p = await (await deployFiles(s, { "main.ts": "x" }, "deno", "rt")).done;
    await edit(s, p.id, { "main.ts": "y" });
    expect(s.previews.get(p.id)!.source).toMatchObject({ runtime: "deno" });
    await edit(s, p.id, { "gangway.yml": "runtime: bun\n", "index.ts": "z" });
    expect(s.previews.get(p.id)!.source).toMatchObject({ runtime: "bun" });
  });
});
