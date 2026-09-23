import { describe, expect, test } from "bun:test";
import { DETECTION, RUNTIMES } from "@gangway/shared/runtimes";
import { deployFiles, runtimesApi, setupRuntimes, tarball } from "../helpers/runtimes-fixtures.ts";

const json = { "content-type": "application/json" };

describe("GET /runtimes", () => {
  test("lists the catalogue and the detection rules", async () => {
    const body = (await (await runtimesApi(setupRuntimes()).request("/runtimes")).json()) as {
      runtimes: { id: string; entries?: unknown }[];
      detection: unknown;
    };
    expect(body.runtimes.map((r) => r.id)).toEqual(RUNTIMES.map((r) => r.id));
    expect(body.runtimes[0]!.entries).toBeUndefined();
    expect(body.detection).toEqual(JSON.parse(JSON.stringify(DETECTION)));
  });

  test("lists the plan files and each runtime's versions", async () => {
    const body = (await (await runtimesApi(setupRuntimes()).request("/runtimes")).json()) as {
      planFiles: string[];
      runtimes: { id: string; versions: string[] }[];
    };
    expect(body.planFiles).toContain("gangway.yml");
    expect(body.runtimes.find((r) => r.id === "node")!.versions.sort()).toEqual(["20", "22", "24"]);
  });
});

describe("a preview's source over HTTP", () => {
  test("an image preview has no source", async () => {
    const s = setupRuntimes();
    const img = await s.deployed("img");
    expect((await runtimesApi(s).request(`/previews/${img.id}/source`)).status).toBe(404);
  });

  test("an upload's source is listed, PATCHed with ?wait, and replaced by PUT", async () => {
    const s = setupRuntimes();
    const app = runtimesApi(s);
    const up = await deployFiles(s, { "index.html": "<h1>1</h1>" }, "static", "up");
    await up.done;
    const src = `/previews/${up.preview.id}/source`;
    expect(await (await app.request(src)).json()).toEqual({
      runtime: "static",
      files: [{ path: "index.html", size: 10, text: "<h1>1</h1>" }],
      truncated: false,
    });

    const patched = await app.request(`${src}?wait=true`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ files: { "index.html": "<h1>2</h1>" } }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      outcome: "succeeded",
      preview: { id: up.preview.id, state: "awake" },
    });

    // An own Dockerfile gets the port the preview already routes to.
    const accepted = await app.request(`${src}?runtime=own`, {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
      body: await tarball({ Dockerfile: "FROM nginx" }),
    });
    expect(accepted.status).toBe(202);
    const body = (await accepted.json()) as { buildId: string; preview: { id: string } };
    expect(Object.keys(body).sort()).toEqual(["buildId", "preview"]);
    await s.ctx.inflight.get(up.preview.id)?.done;

    expect((await app.request(src, { method: "PUT", headers: json, body: "{}" })).status).toBe(400);
  });
});

describe("plans and schema over HTTP", () => {
  test("POST /runtimes/plan answers what a deploy would do", async () => {
    const app = runtimesApi(setupRuntimes());
    const res = await app.request("/runtimes/plan", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        paths: ["package.json", "index.html", "src/main.ts"],
        files: { "package.json": JSON.stringify({ scripts: { build: "vite build" } }) },
      }),
    });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as { runtime: string; serve: { kind: string } };
    expect(plan.runtime).toBe("node");
    expect(plan.serve.kind).toBe("static");
    const bad = await app.request("/runtimes/plan", {
      method: "POST",
      headers: json,
      body: '{"paths":"x"}',
    });
    expect(bad.status).toBe(422);
  });

  test("GET /schema/gangway.yml is a JSON Schema", async () => {
    const res = await runtimesApi(setupRuntimes()).request("/schema/gangway.yml");
    expect(((await res.json()) as { title: string }).title).toBe("gangway.yml");
  });

  test("GET /previews/:id/plan explains the kept source with its recorded runtime", async () => {
    const s = setupRuntimes();
    const res = await deployFiles(s, { "main.ts": "" }, "deno", "pl");
    await res.done;
    const plan = (await (
      await runtimesApi(s).request(`/previews/${res.preview.id}/plan`)
    ).json()) as {
      runtime: string;
    };
    // Not a fresh guess: main.ts alone would read as Bun.
    expect(plan.runtime).toBe("deno");
  });
});
