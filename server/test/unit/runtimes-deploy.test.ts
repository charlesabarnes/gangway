import { describe, expect, test } from "bun:test";
import { destroy } from "../../src/previews/destroy.ts";
import { checkEditPath, redeploy } from "../../src/previews/redeploy.ts";
import { ACTOR } from "../helpers/preview-context.ts";
import {
  deployFiles,
  edit,
  setupRuntimes,
  tarball,
  type RuntimesHarness,
} from "../helpers/runtimes-fixtures.ts";

describe("deploying with a runtime", () => {
  test("an auto-detected upload builds and keeps its source without .gangway/", async () => {
    const s = setupRuntimes();
    const res = await deployFiles(s, {
      "index.ts": "export default { fetch: () => new Response('hi') }",
      ".gangway/evil": "x",
    });
    expect(res.preview.source).toEqual({
      kind: "tarball",
      uploadId: res.preview.id,
      runtime: "bun",
    });
    expect(res.preview.project).toMatch(/-bun-[a-z0-9]{4}$/);
    expect((await res.done).state).toBe("awake");
    expect(s.routes.forPreview(res.preview.id)[0]).toMatchObject({
      service: "web",
      containerPort: 3000,
    });
    const listing = await s.sources.list(res.preview.id);
    expect(listing.files.map((f) => f.path)).toEqual(["index.ts"]);
    expect(listing.files[0]!.text).toContain("export default");
    const log = s.ctx.logs.read(res.preview.id).map((l) => l.line);
    expect(log).toContain("detected runtime bun: bun index.ts");
  });

  test("two runtime deploys with no name do not collide", async () => {
    const s = setupRuntimes();
    const a = await deployFiles(s, { "index.html": "" }, "static");
    const b = await deployFiles(s, { "index.html": "" }, "static");
    expect(a.preview.project).not.toBe(b.preview.project);
    await Promise.all([a.done, b.done]);
  });

  test("a plan failure keeps nothing", async () => {
    const s = setupRuntimes();
    await expect(deployFiles(s, { "README.md": "" }, "python")).rejects.toMatchObject({
      code: "unprocessable",
    });
    expect(await s.sources.ids()).toEqual([]);
  });

  test("destroy removes the kept source", async () => {
    const s = setupRuntimes();
    const res = await deployFiles(s, { "index.html": "" }, "static", "gone");
    await res.done;
    expect(await s.sources.has(res.preview.id)).toBe(true);
    await destroy(s.ctx, res.preview.id, ACTOR);
    expect(await s.sources.has(res.preview.id)).toBe(false);
  });
});

describe("rebuilding in place", () => {
  async function live(s: RuntimesHarness, files: Record<string, string> = { "index.ts": "v1" }) {
    return (await deployFiles(s, files, "bun", "edit")).done;
  }

  test("an edit keeps the preview and route, keeps the new source, and wakes it", async () => {
    const s = setupRuntimes();
    const p = await live(s);
    const before = s.routes.forPreview(p.id);
    const o = await edit(s, p.id, { "index.ts": "v2", "lib/util.ts": "export {}" });
    expect(o).toMatchObject({ outcome: "succeeded", preview: { id: p.id, state: "awake" } });
    expect(s.routes.forPreview(p.id)).toEqual(before);
    const kept = await s.sources.list(p.id);
    expect(kept.files.map((f) => [f.path, f.text])).toEqual([
      ["index.ts", "v2"],
      ["lib/util.ts", "export {}"],
    ]);
    expect(s.fake.builds).toBe(2);
    const events = s.ctx.bus
      .history(p.id)
      .filter((e) => e.type === "preview.redeploy")
      .map((e) => e.payload["phase"]);
    expect(events).toEqual(["started", "succeeded"]);
    const states = s.ctx.bus
      .history(p.id)
      .filter((e) => e.type === "preview.state")
      .map((e) => e.payload["state"]);
    expect(states.slice(-2)).toEqual(["starting", "awake"]);
  });

  test("a failed build leaves the old version serving and keeps the new source", async () => {
    const s = setupRuntimes();
    const p = await live(s);
    s.fake.buildExit = 1;
    const o = await edit(s, p.id, { "index.ts": "broken" });
    expect(o).toMatchObject({
      outcome: "failed",
      error: "compose build exited 1",
      preview: { state: "awake" },
    });
    expect((await s.sources.list(p.id)).files[0]!.text).toBe("broken");
    expect(s.ctx.builds.forPreview(p.id).map((b) => b.state)).toContain("failed");
  });

  test("a failed preview recovers with the next save", async () => {
    const s = setupRuntimes();
    s.fake.answering = false;
    const p = await live(s);
    expect(p.state).toBe("failed");
    s.fake.answering = true;
    const o = await edit(s, p.id, { "index.ts": "fixed" });
    expect(o).toMatchObject({ outcome: "succeeded", preview: { state: "awake" } });
  });

  test("a replacement upload and a runtime change are recorded on the preview", async () => {
    const s = setupRuntimes();
    const p = await live(s);
    const o = await (
      await redeploy(s.ctx, {
        actor: ACTOR,
        previewId: p.id,
        runtime: "deno",
        change: { kind: "replace", archive: await tarball({ "main.ts": "x" }) },
      })
    ).done;
    // deno's own port is 8000; the rebuild keeps the preview's 3000 and tells deno to listen there.
    expect(o.outcome).toBe("succeeded");
    expect(s.previews.get(p.id)!.source).toMatchObject({ runtime: "deno" });
    expect(s.routes.forPreview(p.id)[0]).toMatchObject({ containerPort: 3000 });
  }, 10_000);

  test.each(["../x", "/etc/passwd", "a//b", ".gangway/Dockerfile", "a\\b", ""])(
    "checkEditPath refuses %j",
    (bad) => expect(() => checkEditPath(bad)).toThrow(),
  );

  test("edits may not write into any .gangway/, at any depth", () => {
    expect(() => checkEditPath("site/.gangway/Dockerfile")).toThrow();
    expect(() => checkEditPath("site/gangway.yml")).not.toThrow();
  });

  test("a bad path or a different port is refused and changes nothing", async () => {
    const s = setupRuntimes();
    const p = await live(s);
    await expect(
      redeploy(s.ctx, {
        actor: ACTOR,
        previewId: p.id,
        change: { kind: "edit", files: { "../x": "1" } },
      }),
    ).rejects.toMatchObject({ code: "unprocessable" });
    await expect(
      redeploy(s.ctx, {
        actor: ACTOR,
        previewId: p.id,
        runtime: "own",
        change: {
          kind: "edit",
          files: {
            "compose.yaml":
              "services:\n  web:\n    image: nginx\n    x-gangway: { expose: true, port: 80 }\n",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "unprocessable",
      message: expect.stringContaining("different services or ports"),
    });
    expect((await s.sources.list(p.id)).files.map((f) => f.path)).toEqual(["index.ts"]);
    expect(s.ctx.inflight.size).toBe(0);
  });

  test("a second rebuild while one is running is a conflict", async () => {
    const s = setupRuntimes();
    const p = await live(s);
    const change = (text: string) => ({ kind: "edit" as const, files: { "index.ts": text } });
    const first = await redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: change("a") });
    await expect(
      redeploy(s.ctx, { actor: ACTOR, previewId: p.id, change: change("b") }),
    ).rejects.toMatchObject({ code: "conflict" });
    await first.done;
  });

  test("a preview that is not an upload cannot be rebuilt from source", async () => {
    const s = setupRuntimes();
    const img = await s.deployed("image");
    await expect(
      redeploy(s.ctx, {
        actor: ACTOR,
        previewId: img.id,
        change: { kind: "edit", files: { a: "" } },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("destroy during a rebuild aborts it", async () => {
    const s = setupRuntimes();
    const p = await live(s);
    s.fake.planDelayMs = 0;
    const res = await redeploy(s.ctx, {
      actor: ACTOR,
      previewId: p.id,
      change: { kind: "edit", files: { "index.ts": "z" } },
    });
    await destroy(s.ctx, p.id, ACTOR);
    await res.done;
    expect(s.previews.get(p.id)!.state).toBe("destroyed");
  });
});
