import { describe, expect, test } from "bun:test";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";
import { pushWorkflowFor } from "../../src/projects/workflow.ts";
import { make, SHA, wf } from "../helpers/projects-http.ts";
import { tarball } from "../helpers/runtimes-fixtures.ts";

describe("/v1/projects/:ref/branch", () => {
  const push = (ref = "refs/heads/main", repo = "acme/web-app") => wf(repo, ref, "push");
  const COMPOSE = [
    "services:",
    "  web:",
    "    build: .",
    "    volumes: [{ type: volume, source: data, target: /data }]",
    "    x-gangway: { expose: true, port: 3000 }",
    "volumes:",
    "  data:",
    "",
  ].join("\n");
  const files = (v: string) => ({
    "compose.yaml": COMPOSE,
    Dockerfile: "FROM oven/bun\nCOPY . .\nCMD bun index.ts\n",
    "index.ts": v,
  });
  const setup = () => {
    const t = make();
    t.projects.create({
      orgId: HOME_ORG_ID,
      id: "P1",
      name: "web-app",
      slug: "web-app",
      forge: "github",
      fullName: "acme/web-app",
    });
    t.projects.update("P1", { deployBranch: "main" });
    const put = async (sha: string, v = sha, as = push()) =>
      t.call(`/v1/projects/web-app/branch?sha=${sha}&wait=true`, {
        method: "PUT",
        as,
        tar: await tarball(files(v)),
      });
    return { ...t, put };
  };
  const B = "b".repeat(40);

  test("the first push that serves becomes production; the next rebuilds it in place", async () => {
    const t = setup();
    const res = await t.put(SHA);
    expect(res.status).toBe(201);
    const { preview } = (await res.json()) as any;
    expect(preview).toMatchObject({
      state: "awake",
      projectId: "P1",
      ttlExpiresAt: null,
      source: { kind: "tarball", branch: { repo: "acme/web-app", branch: "main", sha: SHA } },
    });
    expect(preview.visibility).toBe("unlisted");
    expect(preview.urls[0].url).toBe("https://web-app.preview.localhost:8443/");
    expect(t.projects.get("P1")!.productionPreviewId).toBe(preview.id);
    expect(t.refreshes()).toBe(1);
    const promoted = t.s.audit
      .page({ limit: 20 })
      .entries.find((e) => e.action === "project.production");
    expect(promoted).toMatchObject({ target: "P1" });

    const same = await t.put(SHA);
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ unchanged: true, preview: { id: preview.id } });

    const next = await t.put(B, "v2");
    expect(next.status).toBe(201);
    const rebuilt = ((await next.json()) as any).preview;
    expect(rebuilt.id).toBe(preview.id);
    expect(rebuilt.urls[0].url).toBe(preview.urls[0].url);
    expect(t.s.previews.get(preview.id)!.source).toMatchObject({ branch: { sha: B } });
    expect(t.s.fake.downArgvs).toEqual([]);
    expect(t.projects.get("P1")!.productionPreviewId).toBe(preview.id);
    expect(t.refreshes()).toBe(1);
  });

  test("a rebuild that fails answers 502 and keeps the last commit serving", async () => {
    const t = setup();
    const first = ((await (await t.put(SHA)).json()) as any).preview;
    t.s.fake.buildExit = 1;
    const res = await t.put(B, "broken");
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).preview).toMatchObject({ id: first.id, state: "awake" });
    expect(t.s.previews.get(first.id)!.source).toMatchObject({ branch: { sha: SHA } });
    expect(t.projects.get("P1")!.productionPreviewId).toBe(first.id);
  });

  test("a first deploy that never served is replaced by the next push", async () => {
    const t = setup();
    t.s.fake.answering = false;
    const failed = await t.put(SHA);
    expect(failed.status).toBe(502);
    const dead = ((await failed.json()) as any).preview;
    expect(t.projects.get("P1")!.productionPreviewId).toBeNull();
    t.s.fake.answering = true;
    const res = await t.put(B);
    expect(res.status).toBe(201);
    const live = ((await res.json()) as any).preview;
    expect(live.id).not.toBe(dead.id);
    // The new one takes the same fixed name, which clears the destroyed row that held it.
    expect(t.s.previews.get(dead.id)).toBeUndefined();
    expect(t.projects.get("P1")!.productionPreviewId).toBe(live.id);
  });

  test("a deploy branch changed during the build does not take production", async () => {
    const t = setup();
    const res = await t.call(`/v1/projects/web-app/branch?sha=${SHA}`, {
      method: "PUT",
      as: push(),
      tar: await tarball(files("v1")),
    });
    expect(res.status).toBe(202);
    const { id } = ((await res.json()) as any).preview;
    t.projects.update("P1", { deployBranch: "release" });
    await t.s.ctx.inflight.get(id)?.done;
    expect(t.s.previews.get(id)!.state).toBe("awake");
    expect(t.projects.get("P1")!.productionPreviewId).toBeNull();
  });

  test("a push during the first build waits for it, then rebuilds it", async () => {
    const t = setup();
    const send = async (sha: string, v: string) =>
      t.call(`/v1/projects/web-app/branch?sha=${sha}`, {
        method: "PUT",
        as: push(),
        tar: await tarball(files(v)),
      });
    const [a, b] = await Promise.all([send(SHA, "v1"), send(B, "v2")]);
    expect([a.status, b.status]).toEqual([202, 202]);
    const first = ((await a.json()) as any).preview.id;
    expect(((await b.json()) as any).preview.id).toBe(first);
    await t.s.ctx.inflight.get(first)?.done;
    expect(t.s.previews.get(first)).toMatchObject({
      state: "awake",
      source: { branch: { sha: B } },
    });
    expect(t.projects.get("P1")!.productionPreviewId).toBe(first);
  });

  test("a queued push is checked again when its turn comes", async () => {
    const t = setup();
    t.s.fake.buildHang = true;
    const send = async (sha: string) =>
      t.call(`/v1/projects/web-app/branch?sha=${sha}`, {
        method: "PUT",
        as: push(),
        tar: await tarball(files(sha)),
      });
    const a = await send(SHA);
    expect(a.status).toBe(202);
    const queued = send(B);
    await Bun.sleep(50);
    t.projects.update("P1", { deployBranch: "release" });
    t.s.fake.buildHang = false;
    const { id } = ((await a.json()) as any).preview;
    expect((await t.call(`/v1/previews/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await queued).status).toBe(403);
  });

  test("production built from another branch waits until it is unset", async () => {
    const t = setup();
    const first = ((await (await t.put(SHA)).json()) as any).preview;
    t.projects.update("P1", { deployBranch: "release" });
    const refused = await t.put(B, "v2", push("refs/heads/release"));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).detail).toContain("built from acme/web-app@main");
    t.projects.update("P1", { productionPreviewId: null });
    const res = await t.put(B, "v2", push("refs/heads/release"));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).preview).toMatchObject({
      id: first.id,
      source: { branch: { branch: "release", sha: B } },
    });
    expect(t.projects.get("P1")!.productionPreviewId).toBe(first.id);
  });

  test("a production preview chosen by hand is not taken over", async () => {
    const t = setup();
    const other = await t.call("/v1/projects/web-app/pulls/7?wait=true", {
      method: "PUT",
      json: t.body(),
    });
    const id = ((await other.json()) as any).preview.id;
    t.projects.update("P1", { productionPreviewId: id });
    const res = await t.put(SHA);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).detail).toContain("chosen by hand");
  });

  test.each([
    ["a pull request run", wf("acme/web-app", "refs/pull/7/merge")],
    ["another branch", push("refs/heads/dev")],
    ["another repository", push("refs/heads/main", "evil/web-app")],
    ["a tag", push("refs/tags/main")],
  ])("refuses %s", async (_, as) => {
    const t = setup();
    expect((await t.put(SHA, SHA, as)).status).toBe(403);
    expect(t.s.previews.list()).toEqual([]);
  });

  test("no deploy branch, a disabled project and an image body are refused", async () => {
    const t = setup();
    t.projects.update("P1", { deployBranch: null });
    expect((await t.put(SHA)).status).toBe(409);
    t.projects.update("P1", { deployBranch: "main", enabled: false });
    expect((await t.put(SHA)).status).toBe(409);
    t.projects.update("P1", { enabled: true });
    const json = await t.call("/v1/projects/web-app/branch", {
      method: "PUT",
      as: push(),
      json: t.body(),
    });
    expect(json.status).toBe(422);
    expect(t.s.previews.list()).toEqual([]);
  });

  test("a push run may not rebuild any other preview", async () => {
    const t = setup();
    const other = (
      (await (
        await t.call("/v1/projects/web-app/pulls/7?wait=true", { method: "PUT", json: t.body() })
      ).json()) as any
    ).preview;
    const res = await t.call(`/v1/previews/${other.id}/source`, {
      method: "PUT",
      as: push(),
      tar: await tarball(files("x")),
    });
    expect(res.status).toBe(403);
  });

  test("the deploy branch is set on the project and named in the push workflow", async () => {
    const t = setup();
    const bad = await t.call("/v1/projects/web-app", {
      method: "PATCH",
      json: { deployBranch: "a..b" },
    });
    expect(bad.status).toBe(422);
    const ok = await t.call("/v1/projects/web-app", {
      method: "PATCH",
      json: { deployBranch: "release/v2" },
    });
    expect(((await ok.json()) as any).project.deployBranch).toBe("release/v2");
    const res = await t.call("/v1/projects/web-app/workflow?on=push");
    expect(res.headers.get("x-gangway-path")).toBe(".github/workflows/gangway-deploy.yml");
    const yaml = await res.text();
    expect(yaml).toContain("branches: [release/v2]");
    expect(yaml).toContain("GANGWAY_PROJECT: web-app");
    expect(yaml).toContain("/branch?sha=$GITHUB_SHA&wait=true");
    expect(yaml).toContain("id-token: write");
    expect(yaml).not.toMatch(/__[A-Z]+__/);
    t.projects.update("P1", { deployBranch: null });
    expect((await t.call("/v1/projects/web-app/workflow?on=push")).status).toBe(409);
    expect((await t.call("/v1/projects/web-app/workflow?on=tag")).status).toBe(422);
    expect(pushWorkflowFor({ name: "x", slug: "x", deployBranch: "main" }, "https://a")).toContain(
      "branches: [main]",
    );
  });

  test("a deploy host names the first deploy, and renames a live one in place", async () => {
    const t = setup();
    t.projects.update("P1", { deployHost: "shop" });
    const first = ((await (await t.put(SHA)).json()) as any).preview;
    expect(first.urls[0].url).toBe("https://shop.preview.localhost:8443/");
    const patch = (deployHost: string) =>
      t.call("/v1/projects/web-app", { method: "PATCH", json: { deployHost } });
    const res = await patch("duck.preview.localhost");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).renamed).toEqual({
      "shop.preview.localhost": "duck.preview.localhost",
    });
    expect(t.s.ctx.table.forPreview(first.id).map((e) => e.hostname)).toEqual([
      "duck.preview.localhost",
    ]);
    expect(t.s.ctx.logs.read(first.id).map((l) => l.line)).toContain(
      "renamed shop.preview.localhost to duck.preview.localhost",
    );
    const next = ((await (await t.put(B, "v2")).json()) as any).preview;
    expect(next).toMatchObject({ id: first.id });
    expect(next.urls[0].url).toBe("https://duck.preview.localhost:8443/");
  });

  test("a name another preview holds is refused, and a full hostname is claimed", async () => {
    const t = setup();
    await t.put(SHA);
    await t.call("/v1/previews?wait=true", {
      method: "POST",
      json: {
        name: "taken",
        visibility: "public",
        source: { kind: "image", image: "x", port: 80 },
      },
    });
    const patch = (deployHost: string) =>
      t.call("/v1/projects/web-app", { method: "PATCH", json: { deployHost } });
    expect((await patch("taken")).status).toBe(409);
    expect(t.projects.get("P1")!.deployHost).toBeNull();
    expect((await patch("a--b")).status).toBe(422);
    expect((await patch("duck.example.com")).status).toBe(409);
    expect(t.claims).toEqual(["duck.example.com"]);
  });

  test("a slug change renames it, a failed patch renames nothing", async () => {
    const t = setup();
    const { id } = ((await (await t.put(SHA)).json()) as any).preview;
    const hosts = () => t.s.ctx.table.forPreview(id).map((e) => e.hostname);
    t.projects.create({
      orgId: HOME_ORG_ID,
      id: "P2",
      name: "other",
      slug: "other",
      forge: "github",
      fullName: "acme/other",
    });
    const refused = await t.call("/v1/projects/web-app", {
      method: "PATCH",
      json: { repository: "acme/other", deployHost: "duck" },
    });
    expect(refused.status).toBe(409);
    expect(hosts()).toEqual(["web-app.preview.localhost"]);
    const renamed = await t.call("/v1/projects/web-app", {
      method: "PATCH",
      json: { slug: "shop" },
    });
    expect(((await renamed.json()) as any).renamed).toEqual({
      "web-app.preview.localhost": "shop.preview.localhost",
    });
  });

  test("an address changed while the first deploy builds is its name once it serves", async () => {
    const t = setup();
    const res = await t.call(`/v1/projects/web-app/branch?sha=${SHA}`, {
      method: "PUT",
      as: push(),
      tar: await tarball(files("v1")),
    });
    const { id } = ((await res.json()) as any).preview;
    t.projects.update("P1", { deployHost: "duck" });
    await t.s.ctx.inflight.get(id)?.done;
    await Bun.sleep(10);
    expect(t.projects.get("P1")!.productionPreviewId).toBe(id);
    expect(t.s.ctx.table.forPreview(id).map((e) => e.hostname)).toEqual(["duck.preview.localhost"]);
  });

  test("setting the address renames a deploy named before fixed names, even to its slug", async () => {
    const t = setup();
    const { id } = ((await (await t.put(SHA)).json()) as any).preview;
    t.s.ctx.table.relabel(id, "web-app", "web-app-82wk0nfpxc");
    const res = await t.call("/v1/projects/web-app", {
      method: "PATCH",
      json: { deployHost: "web-app" },
    });
    expect(((await res.json()) as any).renamed).toEqual({
      "web-app-82wk0nfpxc.preview.localhost": "web-app.preview.localhost",
    });
  });
});
