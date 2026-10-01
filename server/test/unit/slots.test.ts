import { describe, expect, test } from "bun:test";
import { Slots } from "../../src/util/async.ts";

const settled = async <T>(p: Promise<T>) => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await Bun.sleep(0);
  return done;
};

describe("Slots", () => {
  test("holds the rest back at the limit and serves them in order", async () => {
    const slots = new Slots(() => 2);
    const a = await slots.acquire();
    await slots.acquire();
    const order: string[] = [];
    let waited = 0;
    const c = slots.acquire(undefined, () => waited++).then((r) => (order.push("c"), r));
    const d = slots.acquire(undefined, () => waited++).then((r) => (order.push("d"), r));
    expect(await settled(c)).toBe(false);
    expect(slots.waiting).toBe(2);
    expect(waited).toBe(2);

    a();
    a(); // a second release of the same slot frees nothing more
    await c;
    expect(await settled(d)).toBe(false);
    (await c)();
    await d;
    expect(order).toEqual(["c", "d"]);
  });

  test("0 is no limit", async () => {
    const slots = new Slots(() => 0);
    await Promise.all([1, 2, 3, 4, 5].map(() => slots.acquire()));
    expect(slots.waiting).toBe(0);
  });

  test("an abort while waiting leaves the line and takes no slot", async () => {
    const slots = new Slots(() => 1);
    const first = await slots.acquire();
    const ac = new AbortController();
    const gone = slots.acquire(ac.signal);
    const next = slots.acquire();
    ac.abort(new Error("cancelled"));
    expect(gone).rejects.toThrow("cancelled");
    first();
    await next;
    expect(slots.waiting).toBe(0);
  });

  test("an already aborted signal never queues", async () => {
    const slots = new Slots(() => 1);
    expect(slots.acquire(AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
    expect(slots.waiting).toBe(0);
  });
});
