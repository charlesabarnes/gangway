import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { destroy } from "../../src/previews/destroy.ts";
import { restorePrevious } from "../../src/previews/previous-images.ts";
import { redeploy } from "../../src/previews/redeploy.ts";
import { ACTOR } from "../helpers/preview-context.ts";
import {
  deployFiles,
  edit,
  setupRuntimes,
  type RuntimesHarness,
} from "../helpers/runtimes-fixtures.ts";

const OLD = `sha256:${"a".repeat(64)}`;

/** A bun preview serving v1 from a built image, as the engine would have it. */
async function serving(s: RuntimesHarness) {
  const p = (await deployFiles(s, { "index.ts": "v1" }, "bun", "edit")).done;
  const preview = await p;
  expect(preview.state).toBe("awake");
  const service = Object.keys(s.fake.stacks.at(-1)!["services"] as object)[0]!;
  const ref = `${preview.project}-${service}`;
  s.fake.images.set(`${ref}:latest`, OLD);
  s.fake.containers = [{ ref, id: OLD }];
  return { p: preview, ref };
}

const deployedText = (s: RuntimesHarness, id: string) =>
  readFile(join(s.sources.dirFor(id), "index.ts"), "utf8");
const prevTags = (s: RuntimesHarness) =>
  [...s.fake.images.keys()].filter((k) => k.endsWith(":prev"));
const logText = (s: RuntimesHarness, id: string) =>
  s.ctx.logs
    .read(id)
    .map((l) => l.line)
    .join("\n");

describe("a rebuild that fails rolls back", () => {
  test("a new version that never answers after up brings the previous one back", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    const ups = s.fake.ups;
    // The new version's `up` never answers; the rollback's does.
    s.ctx.probe = async () => s.fake.ups !== ups + 1;

    const o = await edit(s, p.id, { "index.ts": "broken" });

    expect(o).toMatchObject({ outcome: "failed", preview: { state: "awake" } });
    expect(o.error).toContain("never answered");
    expect(s.fake.ups).toBe(ups + 2);
    expect(s.fake.containers).toEqual([{ ref, id: OLD }]);
    expect(s.fake.images.get(`${ref}:latest`)).toBe(OLD);
    expect(prevTags(s)).toEqual([]);
    // Not torn down: volumes and all stay.
    expect(s.fake.downs).not.toContain(p.project);
    // The rollback ran the previous version's stack.
    const stack = (i: number) =>
      JSON.stringify(s.fake.stacks.at(i)).replace(/\/work\/[0-9A-Z]{26}\//g, "/work/<build>/");
    expect(stack(-1)).toBe(stack(-3));
    // The serving source is still v1; the editor keeps the failed edit.
    expect(await deployedText(s, p.id)).toBe("v1");
    expect((await s.sources.list(p.id)).files[0]!.text).toBe("broken");
    const log = logText(s, p.id);
    expect(log).toContain("rolling back to the previous version");
    expect(log).toContain("rolled back to the previous version; it is serving again");
  });

  test("a draft that cannot be kept still rolls back and drops :prev", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    const ups = s.fake.ups;
    s.ctx.probe = async () => s.fake.ups !== ups + 1;
    s.sources.keepDraft = async () => {
      throw new Error("disk full");
    };
    s.ctx.logger = s.logger;

    const o = await edit(s, p.id, { "index.ts": "broken" });

    expect(o).toMatchObject({ outcome: "failed", preview: { state: "awake" } });
    expect(s.fake.images.get(`${ref}:latest`)).toBe(OLD);
    expect(prevTags(s)).toEqual([]);
    expect(s.lines.join("\n")).toContain("could not keep a failed rebuild's draft");
  });

  test("when the previous version does not come back either, the stack is torn down", async () => {
    const s = setupRuntimes();
    const { p } = await serving(s);
    s.fake.answering = false;

    const o = await edit(s, p.id, { "index.ts": "broken" });

    expect(o).toMatchObject({ outcome: "failed", preview: { state: "failed" } });
    expect(s.fake.downs).toContain(p.project);
    expect(prevTags(s)).toEqual([]);
    expect(logText(s, p.id)).toContain("rollback FAILED");
    expect(await deployedText(s, p.id)).toBe("v1");
  });

  test("a failed build keeps :latest on what serves; the next edit builds on the draft", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    s.fake.buildExit = 1;

    const o = await edit(s, p.id, { "index.ts": "broken" });

    expect(o).toMatchObject({ outcome: "failed", preview: { state: "awake" } });
    expect(s.fake.images.get(`${ref}:latest`)).toBe(OLD);
    expect(prevTags(s)).toEqual([]);
    expect(await deployedText(s, p.id)).toBe("v1");
    expect(await s.sources.hasDraft(p.id)).toBe(true);

    s.fake.buildExit = 0;
    const next = await edit(s, p.id, { "lib.ts": "export {}" });
    expect(next.outcome).toBe("succeeded");
    expect(await deployedText(s, p.id)).toBe("broken");
    expect(await s.sources.hasDraft(p.id)).toBe(false);
  });

  test("a build that times out puts :latest back on what serves", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    s.fake.buildHang = true;
    s.ctx.buildTimeoutMs = () => 50;

    const o = await edit(s, p.id, { "index.ts": "slow" });

    expect(o).toMatchObject({ outcome: "failed", preview: { state: "awake" } });
    expect(o.error).toContain("previews.limits.buildTimeout");
    expect(s.fake.images.get(`${ref}:latest`)).toBe(OLD);
    expect(prevTags(s)).toEqual([]);
    expect(await deployedText(s, p.id)).toBe("v1");
  });

  test("a rebuild that serves keeps no :prev tag and stores its source as deployed", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);

    const o = await edit(s, p.id, { "index.ts": "v2" });

    expect(o).toMatchObject({ outcome: "succeeded", preview: { state: "awake" } });
    expect(prevTags(s)).toEqual([]);
    expect(s.fake.images.get(`${ref}:latest`)).not.toBe(OLD);
    expect(s.fake.containers[0]!.id).toBe(s.fake.images.get(`${ref}:latest`)!);
    expect(await deployedText(s, p.id)).toBe("v2");
    expect(await s.sources.hasDraft(p.id)).toBe(false);
  });

  test("destroy drops a :prev tag a rebuild left behind, and the draft", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    s.fake.buildExit = 1;
    await edit(s, p.id, { "index.ts": "broken" });
    s.fake.images.set(`${ref}:prev`, OLD);

    await destroy(s.ctx, p.id, ACTOR);

    expect(prevTags(s)).toEqual([]);
    expect(await s.sources.has(p.id)).toBe(false);
    expect(await s.sources.hasDraft(p.id)).toBe(false);
  });
});

describe("a rebuild that could not roll back is refused", () => {
  /** Make `docker image tag` fail for the targets `fails` picks. */
  function failTags(s: RuntimesHarness, fails: (target: string) => boolean) {
    const capture = s.ctx.compose.capture.bind(s.ctx.compose);
    s.ctx.compose.capture = async (argv, host, o) =>
      argv[1] === "image" && argv[2] === "tag" && fails(argv[4]!)
        ? { code: 1, stdout: "", stderr: "no space left", signal: null }
        : capture(argv, host, o);
  }

  test("a serving preview whose images cannot be tagged changes nothing", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    const builds = s.fake.builds;
    failTags(s, () => true);

    await expect(edit(s, p.id, { "index.ts": "v2" })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("could not keep the serving version's images"),
    });

    expect(s.fake.builds).toBe(builds);
    expect(s.previews.get(p.id)!.state).toBe("awake");
    expect(s.fake.images.get(`${ref}:latest`)).toBe(OLD);
    expect(await deployedText(s, p.id)).toBe("v1");
    expect(await s.sources.hasDraft(p.id)).toBe(false);
    expect(s.ctx.inflight.has(p.id)).toBe(false);
  });

  test("a snapshot that fails halfway drops the tags it made", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    s.fake.containers.push({ ref: `${p.project}-worker`, id: `sha256:${"b".repeat(64)}` });
    failTags(s, (target) => target.startsWith(`${p.project}-worker`));

    await expect(edit(s, p.id, { "index.ts": "v2" })).rejects.toMatchObject({
      code: "unavailable",
    });

    expect(s.fake.all.some((a) => a[2] === "tag" && a[4] === `${ref}:prev`)).toBe(true);
    expect(prevTags(s)).toEqual([]);
  });

  test("an asleep preview's stopped containers are kept, and it rolls back", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    s.ctx.states.transition(p.id, "asleep");
    const ups = s.fake.ups;
    s.ctx.probe = async () => s.fake.ups !== ups + 1;

    const o = await edit(s, p.id, { "index.ts": "broken" });

    expect(o).toMatchObject({ outcome: "failed", preview: { state: "awake" } });
    expect(s.fake.images.get(`${ref}:latest`)).toBe(OLD);
    expect(prevTags(s)).toEqual([]);
  });

  test("a failed preview has nothing to keep and rebuilds without a snapshot", async () => {
    const s = setupRuntimes();
    s.fake.answering = false;
    const p = await (await deployFiles(s, { "index.ts": "v1" }, "bun", "edit")).done;
    expect(p.state).toBe("failed");
    s.fake.containers = [];
    s.fake.answering = true;

    const o = await edit(s, p.id, { "index.ts": "fixed" });

    expect(o).toMatchObject({ outcome: "succeeded", preview: { state: "awake" } });
    expect(s.fake.all.some((a) => a[1] === "ps" && a.includes("--quiet"))).toBe(false);
  });
});

describe("a rebuild that gangway's shutdown interrupts", () => {
  test("after up, the unchecked version is marked failed, never adopted", async () => {
    const s = setupRuntimes();
    const { p } = await serving(s);
    s.ctx.probe = async () => {
      s.ctx.inflight.get(p.id)?.abort.abort();
      return false;
    };

    const o = await edit(s, p.id, { "index.ts": "v2" });

    expect(o).toMatchObject({ error: "cancelled", preview: { state: "failed" } });
    expect(s.previews.get(p.id)!.error).toContain("before it was checked");
    expect(prevTags(s)).toEqual([]);
    expect(await deployedText(s, p.id)).toBe("v1");
  });

  test("during the build, :latest goes back to what serves", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    s.fake.buildHang = true;
    const builds = s.fake.builds;

    const res = await redeploy(s.ctx, {
      actor: ACTOR,
      previewId: p.id,
      change: { kind: "edit", files: { "index.ts": "v2" } },
    });
    while (s.fake.builds === builds) {
      await Bun.sleep(5);
    }
    s.ctx.inflight.get(p.id)!.abort.abort();
    const o = await res.done;

    expect(o).toMatchObject({ error: "cancelled", preview: { state: "awake" } });
    expect(s.fake.images.get(`${ref}:latest`)).toBe(OLD);
    expect(prevTags(s)).toEqual([]);
  });
});

describe("keeping one version consistent", () => {
  test("a source that cannot be stored rolls the new version back", async () => {
    const s = setupRuntimes();
    const { p, ref } = await serving(s);
    s.sources.adopt = async () => {
      throw new Error("disk full");
    };

    const o = await edit(s, p.id, { "index.ts": "v2" });

    expect(o).toMatchObject({ outcome: "failed", preview: { state: "awake" } });
    expect(o.error).toContain("disk full");
    expect(s.fake.images.get(`${ref}:latest`)).toBe(OLD);
    expect(await deployedText(s, p.id)).toBe("v1");
    expect((await s.sources.list(p.id)).files[0]!.text).toBe("v2");
  });

  test("a failed adopt leaves the deployed source in place", async () => {
    const s = setupRuntimes();
    const { p } = await serving(s);

    await expect(s.sources.adopt(p.id, join(s.stateDir, "missing"))).rejects.toThrow();

    expect(await deployedText(s, p.id)).toBe("v1");
  });

  test("a restore that fails halfway puts :latest back and keeps :prev", async () => {
    const s = setupRuntimes();
    const { p } = await serving(s);
    const [web, worker] = [`${p.project}-web`, `${p.project}-worker`];
    const [NEW, PREV] = [`sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`];
    for (const name of [web, worker]) {
      s.fake.images.set(`${name}:latest`, NEW);
      s.fake.images.set(`${name}:prev`, PREV);
    }
    const capture = s.ctx.compose.capture.bind(s.ctx.compose);
    s.ctx.compose.capture = async (argv, host, o) =>
      argv[2] === "tag" && argv[4] === `${worker}:latest`
        ? { code: 1, stdout: "", stderr: "no space left", signal: null }
        : capture(argv, host, o);
    const scope = { host: s.ctx.hosts.get(p.hostId)!, project: p.project, cwd: s.stateDir };

    expect(await restorePrevious(s.ctx, scope, [web, worker])).toBe(false);

    expect(s.fake.images.get(`${web}:latest`)).toBe(NEW);
    expect(s.fake.images.get(`${worker}:latest`)).toBe(NEW);
    expect(prevTags(s).sort()).toEqual([`${web}:prev`, `${worker}:prev`]);
  });
});
