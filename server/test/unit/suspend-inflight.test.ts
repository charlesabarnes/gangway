import { expect, test } from "bun:test";
import { AuditRepo } from "../../src/db/repos/audit.ts";
import { OrgsRepo } from "../../src/db/repos/orgs.ts";
import { TakedownsRepo } from "../../src/db/repos/takedowns.ts";
import { Audit } from "../../src/audit/audit.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { suspendOrg } from "../../src/tenancy/suspend.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { silentLogger } from "../helpers/logger.ts";

test("a deploy running when its org is suspended sleeps once it comes up", async () => {
  const s = setupPreviewContext();
  s.db.run(
    "INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ('o2', 'two', 'Two', 1, 1)",
  );
  s.fake.planDelayMs = 50;
  const { preview, done } = await deploy(s.ctx, s.request("late"));
  s.db.run("UPDATE previews SET org_id = 'o2' WHERE id = $id", { id: preview.id });
  const deps = {
    ctx: s.ctx,
    orgs: new OrgsRepo(s.db),
    takedowns: new TakedownsRepo(s.db),
    audit: new Audit(new AuditRepo(s.db), silentLogger()),
  };
  const res = await suspendOrg(deps, ACTOR, "o2", "mining");
  expect(res.pending).toEqual([preview.id]);
  expect((await done).state).toBe("awake");
  for (let i = 0; i < 200 && s.previews.get(preview.id)!.state !== "asleep"; i++) {
    await Bun.sleep(5);
  }
  expect(s.previews.get(preview.id)!.state).toBe("asleep");
  expect(s.ctx.logs.tail(preview.id).join("\n")).toContain("asleep: the org is suspended");
});
