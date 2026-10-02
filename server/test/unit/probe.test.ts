import { afterAll, describe, expect, test } from "bun:test";
import { httpProbe } from "../../src/previews/probe.ts";

// One app on a real port that answers each path with the status in it: /500 answers 500.
const app = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => new Response("x", { status: Number(new URL(req.url).pathname.slice(1)) || 200 }),
});
afterAll(() => {
  void app.stop(true);
});

const route = {
  hostname: "a.preview.test",
  upstream: { host: "127.0.0.1", port: Number(app.port) },
};
const host = { upstream: { dial: "direct" as const, address: "127.0.0.1", proxy: null } };
const probe = (path: string) => httpProbe(route, host, path);

describe("the readiness probe", () => {
  test("a health path must answer 2xx or 3xx", async () => {
    expect(await probe("/200")).toBe(true);
    expect(await probe("/302")).toBe(true);
    expect(await probe("/404")).toBe(false);
    expect(await probe("/503")).toBe(false);
  });

  test("with no health path a 404 on / is up, but a server error there is not", async () => {
    const at = (status: number) =>
      Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("", { status }) });
    for (const [status, up] of [
      [200, true],
      [404, true],
      [500, false],
      [502, false],
    ] as const) {
      const s = at(status);
      expect(
        await httpProbe({ ...route, upstream: { host: "127.0.0.1", port: Number(s.port) } }, host),
      ).toBe(up);
      await s.stop(true);
    }
  });

  test("nothing listening is not up", async () => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = Number(s.port);
    await s.stop(true);
    expect(await httpProbe({ ...route, upstream: { host: "127.0.0.1", port } }, host)).toBe(false);
  });
});
