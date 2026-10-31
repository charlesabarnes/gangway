import { expect, test } from "bun:test";
import { AuditRepo } from "../../src/db/repos/audit.ts";
import { OrgsRepo } from "../../src/db/repos/orgs.ts";
import { TakedownsRepo } from "../../src/db/repos/takedowns.ts";
import { Audit } from "../../src/audit/audit.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { sleepPreview, Waker } from "../../src/previews/sleep.ts";
import { Blocks } from "../../src/tenancy/blocks.ts";
import { suspendOrg } from "../../src/tenancy/suspend.ts";
import { staticTokenVerifier, type Actor } from "../../src/auth/actor.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { silentLogger } from "../helpers/logger.ts";

const O2 = staticTokenVerifier("x", "o2")("x") as Actor;

function world() {
  const s = setupPreviewContext();
  s.db.run(
    "INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ('o2', 'two', 'Two', 1, 1)",
  );
  const deps = {
    ctx: s.ctx,
    orgs: new OrgsRepo(s.db),
    takedowns: new TakedownsRepo(s.db),
    audit: new Audit(new AuditRepo(s.db), silentLogger()),
  };
  return { s, deps, suspend: () => suspendOrg(deps, ACTOR, "o2", "mining") };
}

test("a deploy already starting when its org is suspended sleeps once it comes up", async () => {
  const { s, suspend } = world();
  await (
    await deploy(s.ctx, { ...s.request("other"), actor: O2 })
  ).done;
  const capture = s.ctx.compose.capture.bind(s.ctx.compose);
  s.ctx.compose = {
    ...s.ctx.compose,
    capture: async (argv, host, o) => {
      if (argv.includes("stop")) {
        await Bun.sleep(100);
      }
      return capture(argv, host, o);
    },
  };
  let suspended: ReturnType<typeof suspend> | undefined;
  const transition = s.ctx.states.transition.bind(s.ctx.states);
  s.ctx.states.transition = (id, to) => {
    const p = transition(id, to);
    if (to === "starting") {
      suspended = suspend();
    }
    return p;
  };
  const { preview, done } = await deploy(s.ctx, { ...s.request("late"), actor: O2 });
  expect((await done).state).toBe("awake");
  expect((await suspended!).pending).toEqual([preview.id]);
  for (let i = 0; i < 200 && s.previews.get(preview.id)!.state !== "asleep"; i++) {
    await Bun.sleep(5);
  }
  expect(s.previews.get(preview.id)!.state).toBe("asleep");
  expect(s.ctx.logs.tail(preview.id).join("\n")).toContain("asleep: the org is suspended");
});

test("a deploy still being planned when its org is suspended never starts", async () => {
  const { s, suspend } = world();
  s.fake.planDelayMs = 50;
  const { done } = await deploy(s.ctx, { ...s.request("early"), actor: O2 });
  await suspend();
  expect((await done).state).toBe("failed");
  expect(s.fake.ups).toBe(0);
});

test("a wake that starts as its org is suspended is refused before anything starts", async () => {
  const { s } = world();
  const p = await s.deployed("napping");
  await sleepPreview(s.ctx, p.id, "idle");
  s.db.run("UPDATE previews SET org_id = 'o2' WHERE id = $id", { id: p.id });
  s.ctx.blocks = new Blocks();
  s.ctx.blocks.suspend("o2", []);
  const starts = s.fake.starts.length;
  await expect(new Waker(s.ctx, silentLogger()).wake(p.id)).rejects.toThrow("suspended");
  expect(s.fake.starts).toHaveLength(starts);
  expect(s.previews.get(p.id)!.state).toBe("asleep");
  expect(s.ctx.inflight.has(p.id)).toBe(false);
});

test("work that ends with its preview asleep or failed still has its stack stopped", async () => {
  const { s, suspend } = world();
  const p = await s.deployed("refused");
  await sleepPreview(s.ctx, p.id, "idle");
  s.db.run("UPDATE previews SET org_id = 'o2' WHERE id = $id", { id: p.id });
  let finish!: () => void;
  const done = new Promise<void>((r) => {
    finish = r;
  }).then(() => s.previews.get(p.id)!);
  s.ctx.inflight.set(p.id, { abort: new AbortController(), done });
  expect((await suspend()).pending).toEqual([p.id]);
  const stops = s.fake.stops.length;
  s.ctx.inflight.delete(p.id);
  finish();
  for (let i = 0; i < 200 && s.fake.stops.length === stops; i++) {
    await Bun.sleep(5);
  }
  expect(s.fake.stops.length).toBe(stops + 1);
  expect(s.previews.get(p.id)!.state).toBe("asleep");
});
