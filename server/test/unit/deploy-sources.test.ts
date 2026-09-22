/** T23: tarball and git sources through the real pipeline (fake compose, real extraction). */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { pack } from "tar-stream";
import { gzipSync } from "node:zlib";
import { deploy } from "../../src/previews/deploy.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

type Entry = { name: string; content?: string; linkname?: string };
async function tarball(entries: Entry[], gzip = true): Promise<Uint8Array> {
  const p = pack();
  for (const e of entries) {
    if (e.linkname !== undefined) p.entry({ name: e.name, type: "symlink", linkname: e.linkname });
    else p.entry({ name: e.name }, e.content ?? "");
  }
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const c of p) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  return gzip ? gzipSync(raw) : raw;
}
const COMPOSE = `services:\n  web:\n    build: .\n    x-gangway: { expose: true, port: 3000 }\n  db:\n    image: postgres:16\n`;
const base = { actor: ACTOR, visibility: "public" as const };

describe("tarball source", () => {
  test("compose.yaml + Dockerfile: built, started, awake -- and the build is on record", async () => {
    const s = setupPreviewContext();
    const archive = await tarball([{ name: "compose.yaml", content: COMPOSE }, { name: "Dockerfile", content: "FROM nginx" }, { name: "src/index.js", content: "1" }]);
    const res = await deploy(s.ctx, { ...base, name: "site", source: { kind: "tarball", archive } });
    expect(res.preview.source).toEqual({ kind: "tarball", uploadId: res.preview.id });
    expect(res.urls.map((u) => u.url)).toEqual(["https://site.preview.localhost:8443/"]);
    expect((await res.done).state).toBe("awake");
    expect(s.fake).toMatchObject({ builds: 1, ups: 1 });
    expect(s.ctx.builds!.forPreview(res.preview.id)).toMatchObject([{ service: "web", state: "succeeded", exitCode: 0 }]);
    const log = s.ctx.logs.read(res.preview.id).map((l) => `${l.stream}: ${l.line}`);
    expect(log.some((l) => l.startsWith("system: unpacked 3 files"))).toBe(true);
    expect(log).toContain("build: #1 [internal] load build definition from Dockerfile");
  });

  test("a plain .tar works too; a Dockerfile with no compose file needs only `port`", async () => {
    const s = setupPreviewContext();
    const archive = await tarball([{ name: "Dockerfile", content: "FROM nginx" }], false);
    await expect(deploy(s.ctx, { ...base, name: "bare", source: { kind: "tarball", archive } })).rejects.toMatchObject({ code: "unprocessable", message: expect.stringContaining("`port` is required") });
    const res = await deploy(s.ctx, { ...base, name: "bare", source: { kind: "tarball", archive, port: 8080 } });
    expect((await res.done).state).toBe("awake");
    expect(s.routes.forPreview(res.preview.id)[0]).toMatchObject({ service: "web", containerPort: 8080 });
  });

  test("a failed build fails the preview, is recorded with its exit code, and nothing is started", async () => {
    const s = setupPreviewContext();
    s.fake.buildExit = 17;
    const res = await deploy(s.ctx, { ...base, name: "broken", source: { kind: "tarball", archive: await tarball([{ name: "Dockerfile", content: "FROM nope" }]), port: 80 } });
    expect(await res.done).toMatchObject({ state: "failed", error: "compose build exited 17" });
    expect(s.ctx.builds!.forPreview(res.preview.id)).toMatchObject([{ state: "failed", exitCode: 17 }]);
    expect(s.fake.ups).toBe(0);
  });

  test.each([
    ["neither a compose file nor a Dockerfile", [{ name: "README.md", content: "hi" }], "no compose file"],
    ["env_file pointing at the server", [{ name: "compose.yaml", content: "services:\n  web:\n    image: nginx\n    env_file: /proc/self/environ\n" }], "outside the uploaded source"],
    ["a build context that climbs out", [{ name: "compose.yaml", content: "services:\n  web:\n    build: ../../..\n    x-gangway: { expose: true, port: 80 }\n" }], "may not have"],
    ["a secret read from gangway's environment", [{ name: "compose.yaml", content: "services:\n  web:\n    image: nginx\n    ports: ['80']\nsecrets:\n  t: { environment: GANGWAY_ADMIN_TOKEN }\n" }], "may not have"],
  ])("refused: %s -- as a 422, leaving no preview, no workdir and no log behind", async (_what, entries, message) => {
    const s = setupPreviewContext();
    await expect(deploy(s.ctx, { ...base, name: "bad", source: { kind: "tarball", archive: await tarball(entries) } }))
      .rejects.toMatchObject({ code: "unprocessable", message: expect.stringContaining(message) });
    expect(s.previews.list({ includeDestroyed: true })).toEqual([]);
    expect(s.fake.ups + s.fake.builds).toBe(0);
    expect(existsSync(s.ctx.workdirs.root) ? (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: s.ctx.workdirs.root, onlyFiles: false }))) : []).toEqual([]);
  });

  test("a symlink out of the tree never reaches compose", async () => {
    const s = setupPreviewContext();
    const archive = await tarball([{ name: "compose.yaml", content: COMPOSE }, { name: ".env", linkname: "/proc/self/environ" }]);
    await expect(deploy(s.ctx, { ...base, name: "sneaky", source: { kind: "tarball", archive } })).rejects.toMatchObject({ status: 422 });
    expect(s.fake.ups + s.fake.builds).toBe(0);
  });
});

describe("git source", () => {
  /** A stand-in `git`: "clones" a repo containing a Dockerfile, and knows its HEAD. */
  const fakeGit = async (dir: string, files: Record<string, string>) => {
    const { chmod, writeFile } = await import("node:fs/promises");
    const path = `${dir}/fake-git.sh`;
    const writes = Object.entries(files).map(([n, c]) => `printf '%s' '${c}' > "$dest/${n}"`).join("\n");
    await writeFile(path, `#!/bin/sh\nif [ "$1" = "clone" ]; then for a; do dest="$a"; done; mkdir -p "$dest"\n${writes}\nexit 0; fi\nif [ "$1" = "rev-parse" ]; then echo 0123456789abcdef0123456789abcdef01234567; exit 0; fi\nexit 0\n`);
    await chmod(path, 0o755);
    return path;
  };

  test("cloned by the server, named after the repo, built from its Dockerfile", async () => {
    const s = setupPreviewContext();
    s.ctx.git = { gitPath: await fakeGit(s.ctx.workdirs.root.replace(/work$/, ""), { Dockerfile: "FROM nginx" }) };
    const res = await deploy(s.ctx, { ...base, source: { kind: "git", repo: "https://github.com/acme/web-app.git", ref: "main", port: 3000 } });
    expect(res.preview).toMatchObject({ project: "gw-default-web-app", source: { kind: "git", repo: "https://github.com/acme/web-app.git", ref: "main" } });
    expect((await res.done).state).toBe("awake");
    expect(s.ctx.logs.read(res.preview.id)[0]!.line).toMatch(/^cloned https:\/\/github.com\/acme\/web-app.git @ main \(0123456789ab\)/);
    expect(s.fake.builds).toBe(1);
  });

  test("a host that is not allowed is refused before anything is cloned", async () => {
    const s = setupPreviewContext();
    await expect(deploy(s.ctx, { ...base, source: { kind: "git", repo: "https://evil.example/x/y.git", ref: "main" } })).rejects.toMatchObject({ status: expect.any(Number) });
    expect(s.previews.list({ includeDestroyed: true })).toEqual([]);
  });
});
