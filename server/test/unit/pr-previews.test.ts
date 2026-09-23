import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors.ts";
import { ProjectsRepo } from "../../src/db/repos/projects.ts";
import type { ForgeEvent } from "../../src/forge/forge.ts";
import { MAX_REPO_SLUG, PrPreviews, slugFor } from "../../src/forge/pr-previews.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { silentLogger } from "../helpers/logger.ts";
import { tempDb } from "../helpers/db.ts";
import { ghRepo, pull, fakeForge, fakePreviews } from "../helpers/forge.ts";

/** `project: false`: acme/web-app is no project yet. Otherwise it is one, taking pull requests by webhook. */
function make(o: Parameters<typeof fakeForge>[0] & { project?: false } = {}) {
  const { db } = tempDb();
  const repos = new ProjectsRepo(db);
  if (o.project !== false)
    repos.create({
      id: "PRJ",
      name: "web-app",
      slug: "web-app",
      forge: "github",
      fullName: "acme/web-app",
      installationId: "4242",
      prTrigger: "webhook",
    });
  const f = fakeForge(o);
  const p = fakePreviews();
  const service = new PrPreviews({
    forge: f.forge,
    repos,
    instance: "test",
    previews: p.previews,
    logger: silentLogger(),
    policy: fixedPolicy(),
    logUrlFor: (id) => `https://app.preview.example.com/previews/${id}`,
  });
  return { service, repos, ...f, ...p };
}

const updated = (
  pr = pull(),
  action: "opened" | "synchronize" | "reopened" | "ready_for_review" = "opened",
): ForgeEvent => ({ type: "pr.updated", pr, action });
const closed = (pr = pull()): ForgeEvent => ({ type: "pr.closed", pr, merged: true });
const command = (
  cmd: "deploy" | "redeploy" | "destroy" | "status",
  association: "owner" | "member" | "collaborator" | "other" = "collaborator",
  number = 123,
): ForgeEvent => ({
  type: "pr.command",
  repo: ghRepo(),
  number,
  command: cmd,
  author: "maintainer",
  association,
  commentId: 1,
});

describe("a pull request opens", () => {
  test("deploys the head as a `pr` source under the project and tells the forge twice", async () => {
    const t = make();
    const out = await t.service.handle(updated());
    expect(out).toMatchObject({ action: "deployed", name: "web-app-pr-123" });
    if (out.action !== "deployed") throw new Error();

    expect(t.deploys[0]).toMatchObject({
      name: "web-app-pr-123",
      projectId: "PRJ",
      actor: { kind: "forge", forge: "github", login: "dev" },
      source: {
        kind: "pr",
        repo: "acme/web-app",
        number: 123,
        sha: "a".repeat(40),
        cloneUrl: "https://github.com/acme/web-app.git",
        credential: "ghs_4242",
      },
    });
    expect(t.deploys[0]!.visibility).toBeUndefined(); // the server default
    expect([...t.comments.values()][0]).toContain("🚧 Building preview for `aaaaaaa`");
    // Unlisted by default: the URL carries the unguessable suffix.
    expect([...t.comments.values()][0]).toContain(
      "https://web-app-pr-123-p1x.preview.example.com/",
    );
    expect(t.deployments[0]).toMatchObject({
      env: "preview/web-app-pr-123",
      sha: "a".repeat(40),
      statuses: [{ state: "in_progress", logUrl: "https://app.preview.example.com/previews/P1" }],
    });
    expect(t.previews.forgeRefs("P1")).toEqual({ commentId: 1, deploymentId: 500 });

    t.settle("P1", "awake");
    await out.settled;
    expect(t.comments.size).toBe(1);
    expect(t.comments.get(1)).toContain("✅ Preview ready");
    expect(t.deployments[0]!.statuses.at(-1)).toEqual({
      state: "success",
      environmentUrl: "https://web-app-pr-123-p1x.preview.example.com/",
      logUrl: "https://app.preview.example.com/previews/P1",
    });
  });

  test("a failed build is reported with its error and marks the deployment failed", async () => {
    const t = make();
    const out = await t.service.handle(updated());
    if (out.action !== "deployed") throw new Error();
    t.settle("P1", "failed", "compose up exited 1");
    await out.settled;
    expect(t.comments.get(1)).toContain("❌ Preview failed");
    expect(t.comments.get(1)).toContain("compose up exited 1");
    expect(t.deployments[0]!.statuses.at(-1)).toMatchObject({ state: "failure" });
  });

  test("a plan refused before any preview exists is reported on the PR as `refused`", async () => {
    const t = make();
    t.previews.deploy = async () => {
      throw new AppError("unprocessable", "the compose file is not valid", {
        compose:
          'time="2026-09-22T01:30:23Z" level=warning msg="The \\"FONTAWESOME_TOKEN\\" variable is not set."\nservice nginx: volumes: bind mounts are not allowed',
      });
    };
    const out = await t.service.handle(updated());
    expect(out).toEqual({ action: "refused", reason: "the compose file is not valid" });
    const body = [...t.comments.values()][0]!;
    expect(body).toContain("❌ Preview refused for `aaaaaaa`");
    expect(body).toContain("bind mounts are not allowed");
    expect(body).not.toContain("level=warning"); // compose's interpolation noise is not the reason
    expect(t.deployments).toEqual([]);
    // A 500 from the pipeline is still a crash.
    t.previews.deploy = async () => {
      throw new AppError("internal", "boom");
    };
    await expect(
      t.service.handle(updated(pull({ headSha: "b".repeat(40) }), "synchronize")),
    ).rejects.toThrow("boom");
  });

  test("the forge being down does not fail the deploy", async () => {
    const t = make({ commentsFail: true });
    const out = await t.service.handle(updated());
    expect(out).toMatchObject({ action: "deployed" });
    expect(t.deploys).toHaveLength(1);
    expect(t.previews.forgeRefs("P1")).toEqual({ commentId: null, deploymentId: 500 });
  });
});

describe("the head moves", () => {
  test("the same head is a no-op; a new head redeploys, keeping the one comment", async () => {
    const t = make();
    const first = await t.service.handle(updated());
    if (first.action !== "deployed") throw new Error();
    expect(await t.service.handle(updated(pull(), "synchronize"))).toMatchObject({
      action: "ignored",
      reason: expect.stringContaining("already building"),
    });
    t.settle("P1", "awake");
    await first.settled;
    expect(await t.service.handle(updated(pull(), "synchronize"))).toMatchObject({
      action: "ignored",
      reason: expect.stringContaining("already awake"),
    });

    const second = await t.service.handle(
      updated(pull({ headSha: "b".repeat(40) }), "synchronize"),
    );
    expect(second).toMatchObject({ action: "deployed", previewId: "P2" });
    expect(t.destroys.map((d) => d.id)).toEqual(["P1"]);
    expect(t.deployments[0]!.statuses.at(-1)).toEqual({ state: "inactive" });
    expect(t.comments.size).toBe(1);
    expect(t.comments.get(1)).toContain("Building preview for `bbbbbbb`");
    expect(t.previews.forgeRefs("P2")).toEqual({ commentId: 1, deploymentId: 501 });
  });

  test("a failed preview is retried on the next push of the same sha", async () => {
    const t = make();
    const first = await t.service.handle(updated());
    if (first.action !== "deployed") throw new Error();
    t.settle("P1", "failed", "boom");
    await first.settled;
    expect(await t.service.handle(updated(pull(), "reopened"))).toMatchObject({
      action: "deployed",
      previewId: "P2",
    });
  });
});

describe("closing", () => {
  test("destroys the preview, retires the deployment, and says so in the same comment", async () => {
    const t = make();
    const out = await t.service.handle(updated());
    if (out.action !== "deployed") throw new Error();
    t.settle("P1", "awake");
    await out.settled;
    expect(await t.service.handle(closed())).toEqual({ action: "destroyed", previewId: "P1" });
    expect(t.destroys.map((d) => d.id)).toEqual(["P1"]);
    expect(t.deployments[0]!.statuses.at(-1)).toEqual({ state: "inactive" });
    expect(t.comments.get(1)).toContain("**web-app-pr-123** closed");
    expect(await t.service.handle(closed())).toMatchObject({
      action: "ignored",
      reason: "#123 has no preview",
    });
  });

  test("closing a PR that has no preview is ignored", async () => {
    const t = make();
    expect(await t.service.handle(closed())).toMatchObject({
      action: "ignored",
      reason: "#123 has no preview",
    });
  });
});

describe("forks and drafts", () => {
  test("a fork's PR is ignored under `ask` and `never`, and deployed public under `auto`", async () => {
    const t = make();
    const fork = pull({ fromFork: true });
    expect(await t.service.handle(updated(fork))).toMatchObject({
      action: "ignored",
      reason: expect.stringContaining("waiting for /preview deploy"),
    });
    expect(t.comments.size).toBe(0);
    const repo = t.repos.getByFullName("github", "acme/web-app")!;
    t.repos.update(repo.id, { forks: "never" });
    expect(await t.service.handle(updated(fork))).toMatchObject({
      action: "ignored",
      reason: expect.stringContaining("never previewed"),
    });
    t.repos.update(repo.id, { forks: "auto", visibility: "private" });
    expect(await t.service.handle(updated(fork))).toMatchObject({ action: "deployed" });
    expect(t.deploys[0]!.visibility).toBe("public");
  });

  test("same-repo PRs get prClearance secrets, forks forkClearance; none is an empty env", async () => {
    const t = make();
    const asked: string[] = [];
    const withSecrets = new PrPreviews({
      forge: t.forge,
      repos: t.repos,
      instance: "test",
      previews: t.previews,
      logger: silentLogger(),
      policy: fixedPolicy(),
      secretsFor: (_repo, clearance) => {
        asked.push(clearance);
        return { LEVEL: clearance };
      },
    });
    await withSecrets.handle(updated());
    expect(t.deploys[0]).toMatchObject({ env: { LEVEL: "standard" }, secretLevel: "standard" });
    const repo = t.repos.getByFullName("github", "acme/web-app")!;
    t.repos.update(repo.id, { forks: "auto" });
    await withSecrets.handle(updated(pull({ number: 124, fromFork: true })));
    expect(t.deploys[1]).toMatchObject({ env: {}, secretLevel: "none" });
    expect(asked).toEqual(["standard"]); // none is never even asked for
    t.repos.update(repo.id, { forkClearance: "low", prClearance: "high" });
    await withSecrets.handle(updated(pull({ number: 125, fromFork: true })));
    expect(t.deploys[2]).toMatchObject({ env: { LEVEL: "low" }, secretLevel: "low" });
    expect([...t.comments.values()].at(-1)).toContain("Secrets: **low**");
  });

  test("`/preview secrets high` redeploys at a level that outlasts pushes and policy", async () => {
    const t = make({ prs: { 123: pull() } });
    const svc = new PrPreviews({
      forge: t.forge,
      repos: t.repos,
      instance: "test",
      previews: t.previews,
      logger: silentLogger(),
      policy: fixedPolicy(),
      secretsFor: (_repo, clearance) => ({ LEVEL: clearance }),
    });
    const first = await svc.handle(updated());
    if (first.action !== "deployed") throw new Error();
    t.settle("P1", "awake");
    await first.settled;
    const raised = await svc.handle({
      ...command("deploy", "owner"),
      command: "secrets",
      level: "high",
    } as never);
    expect(raised).toMatchObject({ action: "deployed", previewId: "P2" });
    expect(t.deploys[1]).toMatchObject({ env: { LEVEL: "high" }, secretLevel: "high" });
    t.settle("P2", "awake");
    const repo = t.repos.getByFullName("github", "acme/web-app")!;
    t.repos.update(repo.id, { prClearance: "low" });
    const pushed = await svc.handle(updated(pull({ headSha: "b".repeat(40) }), "synchronize"));
    expect(pushed).toMatchObject({ action: "deployed", previewId: "P3" });
    expect(t.deploys[2]).toMatchObject({ secretLevel: "high" });
    await svc.handle(updated(pull({ number: 200 })));
    expect(t.deploys[3]).toMatchObject({ secretLevel: "low" });
    expect(
      await svc.handle({
        ...command("deploy", "other"),
        command: "secrets",
        level: "high",
      } as never),
    ).toMatchObject({ action: "ignored" });
  });

  test("a draft is ignored unless the repository opts in", async () => {
    const t = make();
    expect(await t.service.handle(updated(pull({ draft: true })))).toMatchObject({
      action: "ignored",
      reason: "#123 is a draft",
    });
    const repo = t.repos.getByFullName("github", "acme/web-app")!;
    t.repos.update(repo.id, { drafts: true });
    expect(await t.service.handle(updated(pull({ draft: true })))).toMatchObject({
      action: "deployed",
    });
  });

  test("`/preview deploy` builds a fork PR for a collaborator and ignores a contributor", async () => {
    const fork = pull({ fromFork: true, headSha: "c".repeat(40) });
    const t = make({ prs: { 123: fork } });
    expect(await t.service.handle(command("deploy", "other"))).toMatchObject({
      action: "ignored",
      reason: expect.stringContaining("(other)"),
    });
    expect(t.comments.size).toBe(0);
    expect(t.deploys).toHaveLength(0);
    expect(await t.service.handle(command("deploy", "collaborator"))).toMatchObject({
      action: "deployed",
      name: "web-app-pr-123",
    });
    expect(t.deploys[0]).toMatchObject({
      visibility: "public",
      actor: { kind: "forge", login: "maintainer" },
      source: { sha: "c".repeat(40) },
    });
  });

  test("`/preview deploy` on a fork under `never` answers and builds nothing", async () => {
    const t = make({ prs: { 123: pull({ fromFork: true }) } });
    t.repos.update(t.repos.getByFullName("github", "acme/web-app")!.id, { forks: "never" });
    expect(await t.service.handle(command("deploy", "owner"))).toEqual({
      action: "commented",
      previewId: null,
    });
    expect([...t.comments.values()][0]).toContain("never previewed");
    expect(t.deploys).toHaveLength(0);
  });
});

describe("/preview commands", () => {
  test("status reports no preview, or the state and URL in the sticky comment", async () => {
    const t = make({ prs: { 123: pull() } });
    expect(await t.service.handle(command("status"))).toEqual({
      action: "commented",
      previewId: null,
    });
    expect(t.comments.get(1)).toContain("No preview exists");
    const out = await t.service.handle(updated());
    if (out.action !== "deployed") throw new Error();
    t.settle("P1", "awake");
    await out.settled;
    expect(await t.service.handle(command("status", "member"))).toEqual({
      action: "commented",
      previewId: "P1",
    });
    expect(t.comments.size).toBe(2); // the status comment from before the preview existed, plus the sticky one
    expect(t.comments.get(2)).toContain("Preview is **awake**");
    expect(t.comments.get(2)).toContain("https://web-app-pr-123-p1x.preview.example.com/");
  });

  test("redeploy rebuilds the same head; destroy tears down", async () => {
    const t = make({ prs: { 123: pull() } });
    const out = await t.service.handle(updated());
    if (out.action !== "deployed") throw new Error();
    t.settle("P1", "awake");
    await out.settled;
    expect(await t.service.handle(command("redeploy"))).toMatchObject({
      action: "deployed",
      previewId: "P2",
    });
    expect(t.destroys.map((d) => d.id)).toEqual(["P1"]);
    expect(await t.service.handle(command("destroy", "owner"))).toEqual({
      action: "destroyed",
      previewId: "P2",
    });
    expect(t.comments.get(1)).toContain("destroyed on request");
    expect(await t.service.handle(command("destroy", "owner"))).toMatchObject({
      action: "ignored",
      reason: "#123 has no preview to destroy",
    });
  });
});

describe("projects", () => {
  test("a repository that is no project is ignored, `/preview` included", async () => {
    const t = make({ project: false, prs: { 123: pull() } });
    expect(await t.service.handle(updated())).toMatchObject({
      action: "ignored",
      reason: "acme/web-app is not a gangway project; create one to preview its pull requests",
    });
    expect(await t.service.handle(command("deploy", "owner"))).toMatchObject({ action: "ignored" });
    expect(t.repos.list()).toEqual([]);
    expect(t.deploys).toHaveLength(0);
    expect(t.comments.size).toBe(0);
  });

  test("a project that takes pull requests by workflow gets no webhook preview", async () => {
    const t = make({ prs: { 123: pull() } });
    t.repos.update("PRJ", { prTrigger: "workflow" });
    expect(await t.service.handle(updated())).toMatchObject({
      action: "ignored",
      reason: expect.stringContaining("from its workflow"),
    });
    expect(await t.service.handle(closed())).toMatchObject({ action: "ignored" });
    expect(t.deploys).toHaveLength(0);
  });

  test("a moved installation id is saved; a disabled repository stays disabled", async () => {
    const t = make();
    const row = t.repos.getByFullName("github", "acme/web-app")!;
    t.repos.update(row.id, { enabled: false, disabledReason: "paused" });
    expect(
      await t.service.handle(updated(pull({ repo: ghRepo({ installationId: "9" }) }))),
    ).toMatchObject({ action: "ignored", reason: "acme/web-app is disabled: paused" });
    expect(t.repos.get(row.id)).toMatchObject({ installationId: "9", enabled: false });
  });

  test("slugFor: slugified, capped, never empty", () => {
    expect(slugFor("Web App")).toBe("web-app");
    expect(slugFor("a-very-long-repository-name-that-goes-on-and-on")).toHaveLength(MAX_REPO_SLUG);
    expect(slugFor("a-very-long-repository-name-that-goes-on-and-on")).not.toMatch(/-$/);
    expect(slugFor("___")).toBe("repo");
  });
});
