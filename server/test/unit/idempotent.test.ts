import { describe, expect, test } from "bun:test";
import { actorId, tokenActor, type Actor } from "../../src/auth/actor.ts";
import { IdempotencyRepo } from "../../src/db/repos/index.ts";
import { destroy } from "../../src/previews/destroy.ts";
import {
  IDEMPOTENCY_TTL_MS,
  IdempotentDeploys,
  requestHash,
} from "../../src/previews/idempotent.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

function setup() {
  const s = setupPreviewContext();
  const keys = new IdempotencyRepo(s.db, s.ctx.now);
  return { ...s, keys, deploys: new IdempotentDeploys(s.ctx, keys) };
}

describe("requestHash", () => {
  test("ignores key order and the actor; notices everything else", () => {
    const s = setup();
    const a = s.request("x");
    expect(requestHash(a)).toBe(
      requestHash({
        source: a.source,
        visibility: a.visibility,
        name: a.name,
        actor: tokenActor("other", ["admin"]),
      }),
    );
    expect(requestHash(a)).not.toBe(requestHash({ ...a, ttl: "1h" }));
    expect(requestHash(a)).not.toBe(
      requestHash({ ...a, source: { kind: "image", image: "traefik/whoami:v1.10", port: 81 } }),
    );
    expect(requestHash(a)).toBe(requestHash({ ...a, hostId: undefined }));
  });
});

describe("IdempotentDeploys", () => {
  test("without a key every call is a new deploy, so a same-named second one conflicts", async () => {
    const s = setup();
    const first = await s.deploys.deploy(s.request("plain"), undefined);
    expect(first.replayed).toBe(false);
    await first.done;
    await expect(s.deploys.deploy(s.request("plain"), undefined)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  test("three retries give one preview and one URL, replaying its current state", async () => {
    const s = setup();
    const first = await s.deploys.deploy(s.request("agent"), "key-1");
    expect(first.replayed).toBe(false);
    expect(first.preview.state).toBe("building");
    await first.done;

    const again = await s.deploys.deploy(s.request("agent"), "key-1");
    const third = await s.deploys.deploy(s.request("agent"), "key-1");
    expect(again.replayed && third.replayed).toBe(true);
    expect(again.preview.id).toBe(first.preview.id);
    expect(again.preview.state).toBe("awake");
    expect(again.urls).toEqual(first.urls);
    expect((await again.done).state).toBe("awake");
    expect(s.previews.list().length).toBe(1);
    expect(s.fake.ups).toBe(1);
  });

  test("a retry while the first is still deploying waits on the same pipeline", async () => {
    const s = setup();
    const first = await s.deploys.deploy(s.request("slow"), "k");
    const retry = await s.deploys.deploy(s.request("slow"), "k");
    expect(retry.replayed).toBe(true);
    expect(retry.done).toBe(s.ctx.inflight.get(first.preview.id)!.done);
    await retry.done;
  });

  test("concurrent retries before any row exists: one deploy, everyone gets it", async () => {
    const s = setup();
    s.fake.planDelayMs = 30;
    const results = await Promise.all(
      [1, 2, 3].map(() => s.deploys.deploy(s.request("race"), "k")),
    );
    expect(new Set(results.map((r) => r.preview.id)).size).toBe(1);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true, true]);
    await Promise.all(results.map((r) => r.done));
    expect(s.fake.ups).toBe(1);
  });

  test("same key with a different request is 422, whether the first finished or not", async () => {
    const s = setup();
    await (
      await s.deploys.deploy(s.request("one"), "k")
    ).done;
    await expect(s.deploys.deploy(s.request("two"), "k")).rejects.toMatchObject({
      code: "unprocessable",
    });
    await expect(s.deploys.deploy({ ...s.request("one"), ttl: "1h" }, "k")).rejects.toMatchObject({
      code: "unprocessable",
    });

    s.fake.planDelayMs = 30;
    const [a, b] = await Promise.allSettled([
      s.deploys.deploy(s.request("three"), "k2"),
      s.deploys.deploy(s.request("four"), "k2"),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { code: "unprocessable" } });
    expect(s.previews.getByProject("gw-four")).toBeUndefined();
    if (a.status === "fulfilled") await a.value.done;
  });

  test("keys are scoped per token: another agent's identical key is a different key", async () => {
    const s = setup();
    const other = tokenActor("someone-else", ["admin"]);
    const mine = await s.deploys.deploy(s.request("mine"), "shared");
    const theirs = await s.deploys.deploy({ ...s.request("theirs"), actor: other }, "shared");
    expect(theirs.replayed).toBe(false);
    expect(theirs.preview.id).not.toBe(mine.preview.id);
    await Promise.all([mine.done, theirs.done]);
  });

  test("a user and a token are different principals even when their raw ids are equal", async () => {
    const s = setup();
    const raw = actorId(ACTOR);
    const user: Actor = {
      kind: "user",
      userId: raw,
      roleId: "member",
      permissions: ACTOR.permissions,
      sessionId: "sess",
    };
    const asToken = await s.deploys.deploy(s.request("from-token"), "shared");
    const asUser = await s.deploys.deploy({ ...s.request("from-user"), actor: user }, "shared");
    expect(asUser.replayed).toBe(false);
    expect(asUser.preview.id).not.toBe(asToken.preview.id);
    expect(s.keys.get("shared", `user:${raw}`)!.previewId).toBe(asUser.preview.id);
    await Promise.all([asToken.done, asUser.done]);
  });

  test("a rejected deploy records nothing, so a fixed request may reuse the key", async () => {
    const s = setup();
    const bad = { ...s.request("bad"), ttl: "soon" };
    await expect(s.deploys.deploy(bad, "k")).rejects.toMatchObject({ code: "unprocessable" });
    await expect(s.deploys.deploy(bad, "k")).rejects.toMatchObject({ code: "unprocessable" });
    expect(s.keys.get("k", actorId(ACTOR))).toBeUndefined();
    const fixed = await s.deploys.deploy(s.request("bad"), "k");
    expect(fixed.replayed).toBe(false);
    await fixed.done;
  });

  test("a failed preview is replayed, since a retry is not a redeploy", async () => {
    const s = setup();
    s.ctx.probe = async () => false;
    const first = await s.deploys.deploy(s.request("broken"), "k");
    expect((await first.done).state).toBe("failed");
    const again = await s.deploys.deploy(s.request("broken"), "k");
    expect(again).toMatchObject({
      replayed: true,
      preview: { id: first.preview.id, state: "failed" },
    });
  });

  test("once the preview is destroyed the key is free to mean something new", async () => {
    const s = setup();
    const first = await s.deploys.deploy(s.request("gone"), "k");
    await first.done;
    await destroy(s.ctx, first.preview.id, ACTOR);
    const second = await s.deploys.deploy(s.request("different"), "k");
    expect(second.replayed).toBe(false);
    expect(second.preview.id).not.toBe(first.preview.id);
    expect(s.keys.get("k", actorId(ACTOR))!.previewId).toBe(second.preview.id);
    await second.done;
  });

  test("keys expire after 24h, and purge() removes them", async () => {
    const s = setup();
    await (
      await s.deploys.deploy(s.request("old"), "k")
    ).done;
    expect(s.deploys.purge()).toBe(0);
    s.clock.offset = IDEMPOTENCY_TTL_MS + 1_000;
    // Expired: no longer a replay. The name is still taken, so this is the ordinary 409.
    await expect(s.deploys.deploy(s.request("old"), "k")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(s.deploys.purge()).toBe(1);
    expect(s.keys.get("k", actorId(ACTOR))).toBeUndefined();
  });

  test("a malformed key is a 400, not a row", async () => {
    const s = setup();
    for (const key of ["", "has space", "x".repeat(256), "naïve"]) {
      await expect(s.deploys.deploy(s.request("x"), key)).rejects.toMatchObject({
        code: "bad_request",
      });
    }
  });
});
