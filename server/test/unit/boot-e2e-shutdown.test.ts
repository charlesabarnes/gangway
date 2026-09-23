import { describe, expect, test } from "bun:test";
import { API, bootE2e, deployPreview } from "../helpers/boot-e2e.ts";

describe("graceful shutdown", () => {
  async function bootWithHello() {
    const booted = await bootE2e();
    expect((await deployPreview(booted.running, { name: "hello" })).status).toBe(201);
    return booted;
  }

  test("stop() lets a proxied request finish, ends SSE, and waits no longer", async () => {
    const { running, call } = await bootWithHello();
    const events = await call(API, "/v1/events");
    const reader = events.body!.getReader();
    const slow = call("hello.preview.localhost", "/?slow=400");
    await Bun.sleep(100);
    expect(running.listener.pending().requests).toBeGreaterThanOrEqual(2);

    const began = Date.now();
    await running.stop({ graceMs: 5_000 });
    const took = Date.now() - began;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(3_000);

    const page = await slow;
    expect(page.status).toBe(200);
    expect(((await page.json()) as { iAm: string }).iAm).toBe("the container");
    for (;;) {
      if ((await reader.read()).done) break;
    }
    // stop() is idempotent, even after the database is closed.
    await running.stop();
  });

  test("a request that will not finish is cut at the deadline", async () => {
    const { running, call } = await bootWithHello();
    const stuck = call("hello.preview.localhost", "/?slow=30000").then(
      (r) => r.status,
      () => "cut",
    );
    await Bun.sleep(100);
    const began = Date.now();
    await running.stop({ graceMs: 300 });
    expect(Date.now() - began).toBeLessThan(2_500);
    expect(await stuck).not.toBe(200);
  });
});
