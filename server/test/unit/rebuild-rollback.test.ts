import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { destroy } from "../../src/previews/destroy.ts";
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
