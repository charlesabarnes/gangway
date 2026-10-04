import { describe, expect, test } from "bun:test";
import { deploy } from "../../src/previews/deploy.ts";
import { tokenActor } from "../../src/auth/actor.ts";
import { setupPreviewContext } from "../helpers/preview-context.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";

const OTHER = tokenActor("tok_other", ["admin"], HOME_ORG_ID);

describe("how many previews may run at once", () => {
  test("past the per-user limit a deploy is refused; someone else may still deploy", async () => {
    const s = setupPreviewContext();
    s.ctx.quota = () => ({ active: 0, perUser: 2 });
    expect((await s.deployed("one")).state).toBe("awake");
    expect((await s.deployed("two")).state).toBe("awake");
    await expect(deploy(s.ctx, s.request("three"))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("previews.limits.activePerUser"),
    });
    expect(s.previews.getByProject("three")).toBeUndefined();
    const other = await deploy(s.ctx, { ...s.request("four"), actor: OTHER });
    expect((await other.done).state).toBe("awake");
  });

  test("past the server's limit nobody may deploy", async () => {
    const s = setupPreviewContext();
    s.ctx.quota = () => ({ active: 1, perUser: 0 });
    await s.deployed("one");
    await expect(deploy(s.ctx, { ...s.request("two"), actor: OTHER })).rejects.toMatchObject({
      message: expect.stringContaining("previews.limits.active"),
    });
  });

  test("failed and destroyed previews do not count, and 0 turns a limit off", async () => {
    const s = setupPreviewContext();
    s.ctx.quota = () => ({ active: 1, perUser: 1 });
    s.fake.answering = false;
    expect((await s.deployed("broken")).state).toBe("failed");
    s.fake.answering = true;
    expect((await s.deployed("fixed")).state).toBe("awake");

    s.ctx.quota = () => ({ active: 0, perUser: 0 });
    expect((await s.deployed("more")).state).toBe("awake");
  });
});
