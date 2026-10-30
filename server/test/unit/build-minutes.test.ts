import { describe, expect, test } from "bun:test";
import { BuildsRepo } from "../../src/db/repos/builds.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { tarball } from "../helpers/runtimes-fixtures.ts";

const MIN = 60_000;

async function start(s: ReturnType<typeof setupPreviewContext>, name = "minutes") {
  return deploy(s.ctx, {
    actor: ACTOR,
    visibility: "public",
    name,
    source: { kind: "tarball", archive: await tarball({ Dockerfile: "FROM x" }), port: 80 },
  });
}

function used(s: ReturnType<typeof setupPreviewContext>, orgId: string, ms: number) {
  const month = new Date().toISOString().slice(0, 7);
  s.db.run("INSERT INTO org_build_usage (org_id, month, build_ms) VALUES ($o, $m, $ms)", {
    o: orgId,
    m: month,
    ms,
  });
}

describe("build minutes", () => {
  test("a finished build adds its time to its org's month, once", async () => {
    const s = setupPreviewContext();
    const res = await start(s);
    await res.done;
    const preview = res.preview;
    let now = Date.parse("2026-10-31T23:59:00Z");
    const builds = new BuildsRepo(s.db, () => now);
    builds.start({ id: "b1", previewId: preview.id, services: ["web"] });
    now += 2 * MIN;
    builds.finish("b1", "succeeded", 0);
    builds.finish("b1", "failed", 1);
    expect(builds.usedThisMonth(preview.orgId)).toBe(2 * MIN);
    now = Date.parse("2026-12-01T00:00:00Z");
    expect(builds.usedThisMonth(preview.orgId)).toBe(0);
  });

  test("an org out of minutes fails before it builds, saying when they return", async () => {
    const s = setupPreviewContext();
    s.ctx.orgLimits = () => ({ buildMinutes: 10 });
    used(s, ACTOR.orgId, 10 * MIN);
    const res = await start(s);
    expect(await res.done).toMatchObject({
      state: "failed",
      error: expect.stringContaining("used its 10 build minutes for the month"),
    });
    expect(s.fake.builds).toBe(0);
  });

  test("a build is stopped when it uses the rest of the org's minutes", async () => {
    const s = setupPreviewContext();
    s.fake.buildHang = true;
    s.ctx.orgLimits = () => ({ buildMinutes: 10 });
    used(s, ACTOR.orgId, 10 * MIN - 50);
    const res = await start(s);
    expect(await res.done).toMatchObject({
      state: "failed",
      error: expect.stringContaining("used the rest of the org's build minutes"),
    });
  });
});
