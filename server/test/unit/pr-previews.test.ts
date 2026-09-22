/**
 * The PR lifecycle (ADR-0011) against a fake forge and a fake preview service, with a real
 * repos table. Every rule in pr-previews.ts has a case here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Preview } from "../../../shared/src/domain.ts";
import type { Actor } from "../../src/auth/actor.ts";
import { AppError } from "../../src/errors.ts";
import { migrate } from "../../src/db/migrate.ts";
import { ReposRepo } from "../../src/db/repos/repos.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import type { DeploymentState, Forge, ForgeEvent, ForgeRepo, PullRequest } from "../../src/forge/forge.ts";
import { MAX_REPO_SLUG, PrPreviews, slugFor } from "../../src/forge/pr-previews.ts";
import { Logger } from "../../src/logger.ts";
import type { DeployInput, DeployResult, PreviewUrl } from "../../src/previews/deploy.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ghRepo = (over: Partial<ForgeRepo> = {}): ForgeRepo => ({
  forge: "github", fullName: "acme/web-app", owner: "acme", name: "web-app", cloneUrl: "https://github.com/acme/web-app.git", installationId: "4242", private: false, ...over,
});
const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: ghRepo(), number: 123, title: "Add the thing", headSha: "a".repeat(40), headRef: "feature", baseRef: "main",
  fromFork: false, draft: false, author: "dev", htmlUrl: "https://github.com/acme/web-app/pull/123", ...over,
});

type Deployment = { id: number; env: string; sha: string; statuses: { state: DeploymentState; environmentUrl?: string; logUrl?: string }[] };

/** A forge that remembers what it was told. */
function fakeForge(o: { commentsFail?: boolean; prs?: Record<number, PullRequest> } = {}) {
  const comments = new Map<number, string>();
  const deployments: Deployment[] = [];
  const credentials: string[] = [];
  let nextComment = 1;
  const forge: Forge = {
    id: "github",
    verify: () => ({ ok: true, deliveryId: "d" }),
    parse: () => ({ type: "ignored", reason: "unused" }),
    async pullRequest(repo, number) {
      const pr = o.prs?.[number];
      if (!pr) throw new Error(`no such PR ${number}`);
      return { ...pr, repo };
    },
    async cloneCredential(repo) { credentials.push(repo.installationId); return `ghs_${repo.installationId}`; },
    async upsertComment(_pr, existingId, body) {
      if (o.commentsFail) throw new Error("GitHub is down");
      const id = existingId !== null && comments.has(existingId) ? existingId : nextComment++;
      comments.set(id, body);
      return id;
    },
    async createDeployment(pr, env) { const id = 500 + deployments.length; deployments.push({ id, env, sha: pr.headSha, statuses: [] }); return id; },
    async setDeploymentStatus(_repo, id, state, extra = {}) { deployments.find((d) => d.id === id)!.statuses.push({ state, ...extra }); },
  };
  return { forge, comments, deployments, credentials };
}

/** A preview service that keeps rows in memory and lets the test settle each deploy. */
function fakePreviews(instance = "test") {
  const rows = new Map<string, Preview>();
  const refs = new Map<string, { commentId: number | null; deploymentId: number | null }>();
  const deploys: DeployInput[] = [];
  const destroys: { id: string; actor: Actor }[] = [];
  const pending = new Map<string, (final: Preview) => void>();
  let seq = 0;
  const urlsFor = (p: Preview): PreviewUrl[] => [{ service: "web", url: `https://${p.project.replace(`gw-${instance}-`, "")}.preview.example.com/`, primary: true }];
  void urlsFor;
  const previews = {
    async deploy(input: DeployInput): Promise<DeployResult> {
      deploys.push(input);
      const id = `P${++seq}`;
      // Like deploy.ts: an unlisted preview's name gets an unguessable suffix, so the project is NOT the PR's stable name.
      const slug = (input.visibility ?? "unlisted") === "unlisted" ? `${input.name}-${id.toLowerCase()}x` : input.name;
      const s = input.source;
      const preview: Preview = {
        id, project: `gw-${instance}-${slug}`, hostId: "local", kind: "preview", state: "building",
        source: s.kind === "pr" ? { kind: "pr", repo: s.repo, number: s.number, sha: s.sha } : { kind: "image", image: "x" },
        visibility: input.visibility ?? "unlisted", ttlExpiresAt: input.ttl ? new Date(Date.now() + 86_400_000) : null,
        lastSeenAt: null, error: null, createdAt: new Date(), updatedAt: new Date(), destroyedAt: null,
      };
      rows.set(id, preview);
      const done = new Promise<Preview>((resolve) => pending.set(id, (final) => { rows.set(id, final); resolve(final); }));
      return { preview, urls: urlsFor(preview), done };
    },
    async destroy(id: string, actor: Actor) {
      const p = rows.get(id)!;
      destroys.push({ id, actor });
      const gone = { ...p, state: "destroyed" as const, destroyedAt: new Date() };
      rows.set(id, gone);
      return gone;
    },
    findPullRequest: (repo: string, number: number) => [...rows.values()].reverse().find((p) => p.source.kind === "pr" && p.source.repo === repo && p.source.number === number && p.state !== "destroyed"),
    urls: (id: string) => urlsFor(rows.get(id)!),
    forgeRefs: (id: string) => refs.get(id) ?? { commentId: null, deploymentId: null },
    setForgeRefs: (id: string, r: { commentId?: number | null; deploymentId?: number | null }) => { refs.set(id, { ...previews.forgeRefs(id), ...r }); },
  };
  const settle = (id: string, state: "awake" | "failed", error: string | null = null) => {
    const p = rows.get(id)!;
    pending.get(id)!({ ...p, state, error });
  };
  return { previews, rows, deploys, destroys, settle };
}

function make(o: Parameters<typeof fakeForge>[0] = {}) {
  const d = mkdtempSync(join(tmpdir(), "gangway-pr-")); tmps.push(d);
  const { db } = openDatabase({ path: join(d, "g.db") });
  migrate(db, MIGRATIONS);
  const repos = new ReposRepo(db);
  const f = fakeForge(o);
  const p = fakePreviews();
  const service = new PrPreviews({
    forge: f.forge, repos, instance: "test", previews: p.previews, logger: new Logger("error", {}, () => {}),
    logUrlFor: (id) => `https://app.preview.example.com/previews/${id}`,
  });
  return { service, repos, ...f, ...p };
}

const updated = (pr = pull(), action: "opened" | "synchronize" | "reopened" | "ready_for_review" = "opened"): ForgeEvent => ({ type: "pr.updated", pr, action });
const closed = (pr = pull()): ForgeEvent => ({ type: "pr.closed", pr, merged: true });
const command = (cmd: "deploy" | "redeploy" | "destroy" | "status", association: "owner" | "member" | "collaborator" | "other" = "collaborator", number = 123): ForgeEvent =>
  ({ type: "pr.command", repo: ghRepo(), number, command: cmd, author: "maintainer", association, commentId: 1 });

describe("a pull request opens", () => {
  test("registers the repository, deploys the head as a `pr` source with a credential, and tells the forge twice", async () => {
    const t = make();
    const out = await t.service.handle(updated());
    expect(out).toMatchObject({ action: "deployed", name: "web-app-pr-123" });
    if (out.action !== "deployed") throw new Error();

    expect(t.repos.getByFullName("github", "acme/web-app")).toMatchObject({ slug: "web-app", enabled: true, installationId: "4242" });
    expect(t.deploys[0]).toMatchObject({
      name: "web-app-pr-123", actor: { kind: "forge", forge: "github", login: "dev" },
      source: { kind: "pr", repo: "acme/web-app", number: 123, sha: "a".repeat(40), cloneUrl: "https://github.com/acme/web-app.git", credential: "ghs_4242" },
    });
    expect(t.deploys[0]!.visibility).toBeUndefined(); // the server default
    // Told the forge as soon as the preview row existed.
    expect([...t.comments.values()][0]).toContain("🚧 Building preview for `aaaaaaa`");
    // The server default is unlisted: the URL carries the unguessable suffix, and is found again by SOURCE, not name.
    expect([...t.comments.values()][0]).toContain("https://web-app-pr-123-p1x.preview.example.com/");
    expect(t.deployments[0]).toMatchObject({ env: "preview/web-app-pr-123", sha: "a".repeat(40), statuses: [{ state: "in_progress", logUrl: "https://app.preview.example.com/previews/P1" }] });
    expect(t.previews.forgeRefs("P1")).toEqual({ commentId: 1, deploymentId: 500 });

    t.settle("P1", "awake");
    await out.settled;
    expect(t.comments.size).toBe(1);
    expect(t.comments.get(1)).toContain("✅ Preview ready");
    expect(t.deployments[0]!.statuses.at(-1)).toEqual({ state: "success", environmentUrl: "https://web-app-pr-123-p1x.preview.example.com/", logUrl: "https://app.preview.example.com/previews/P1" });
  });

  test("a failed build is reported as failed, with the error, and the deployment marked failure", async () => {
    const t = make();
    const out = await t.service.handle(updated());
    if (out.action !== "deployed") throw new Error();
    t.settle("P1", "failed", "compose up exited 1");
    await out.settled;
    expect(t.comments.get(1)).toContain("❌ Preview failed");
    expect(t.comments.get(1)).toContain("compose up exited 1");
    expect(t.deployments[0]!.statuses.at(-1)).toMatchObject({ state: "failure" });
  });

  test("a plan refused before any preview exists is SAID on the PR, with compose's stderr, and is a `refused` outcome", async () => {
    const t = make();
    t.previews.deploy = async () => { throw new AppError("unprocessable", "the compose file is not valid", { compose: 'time="2026-09-22T01:30:23Z" level=warning msg="The \\"FONTAWESOME_TOKEN\\" variable is not set."\nservice nginx: volumes: bind mounts are not allowed' }); };
    const out = await t.service.handle(updated());
    expect(out).toEqual({ action: "refused", reason: "the compose file is not valid" });
    const body = [...t.comments.values()][0]!;
    expect(body).toContain("❌ Preview refused for `aaaaaaa`");
    expect(body).toContain("bind mounts are not allowed");
    expect(body).not.toContain("level=warning"); // compose's interpolation noise, seen on tower, is not the reason
    expect(t.deployments).toEqual([]);
    // Not a crash: a 500 from the pipeline still is.
    t.previews.deploy = async () => { throw new AppError("internal", "boom"); };
    await expect(t.service.handle(updated(pull({ headSha: "b".repeat(40) }), "synchronize"))).rejects.toThrow("boom");
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
  test("the same head already building or awake is a no-op; a new head destroys then redeploys, keeping the ONE comment", async () => {
    const t = make();
    const first = await t.service.handle(updated());
    if (first.action !== "deployed") throw new Error();
    expect(await t.service.handle(updated(pull(), "synchronize"))).toMatchObject({ action: "ignored", reason: expect.stringContaining("already building") });
    t.settle("P1", "awake"); await first.settled;
    expect(await t.service.handle(updated(pull(), "synchronize"))).toMatchObject({ action: "ignored", reason: expect.stringContaining("already awake") });

    const second = await t.service.handle(updated(pull({ headSha: "b".repeat(40) }), "synchronize"));
    expect(second).toMatchObject({ action: "deployed", previewId: "P2" });
    expect(t.destroys.map((d) => d.id)).toEqual(["P1"]);
    expect(t.deployments[0]!.statuses.at(-1)).toEqual({ state: "inactive" });
    expect(t.comments.size).toBe(1);
    expect(t.comments.get(1)).toContain("Building preview for `bbbbbbb`");
    expect(t.previews.forgeRefs("P2")).toEqual({ commentId: 1, deploymentId: 501 });
  });

  test("a failed preview at the same head IS retried on the next push of the same sha", async () => {
    const t = make();
    const first = await t.service.handle(updated());
    if (first.action !== "deployed") throw new Error();
    t.settle("P1", "failed", "boom"); await first.settled;
    expect(await t.service.handle(updated(pull(), "reopened"))).toMatchObject({ action: "deployed", previewId: "P2" });
  });
});

describe("closing", () => {
  test("destroys the preview, retires the deployment, and says so in the same comment", async () => {
    const t = make();
    const out = await t.service.handle(updated());
    if (out.action !== "deployed") throw new Error();
    t.settle("P1", "awake"); await out.settled;
    expect(await t.service.handle(closed())).toEqual({ action: "destroyed", previewId: "P1" });
    expect(t.destroys.map((d) => d.id)).toEqual(["P1"]);
    expect(t.deployments[0]!.statuses.at(-1)).toEqual({ state: "inactive" });
    expect(t.comments.get(1)).toContain("**web-app-pr-123** closed");
    expect(await t.service.handle(closed())).toMatchObject({ action: "ignored", reason: "#123 has no preview" });
  });

  test("closing on a repository that never opened anything is ignored, and registers nothing", async () => {
    const t = make();
    expect(await t.service.handle(closed())).toMatchObject({ action: "ignored" });
    expect(t.repos.list()).toEqual([]);
  });
});

describe("forks and drafts (§9)", () => {
  test("a fork's PR is ignored under `ask` (the default) and `never`; deployed PUBLIC under `auto`", async () => {
    const t = make();
    const fork = pull({ fromFork: true });
    expect(await t.service.handle(updated(fork))).toMatchObject({ action: "ignored", reason: expect.stringContaining("waiting for /preview deploy") });
    expect(t.comments.size).toBe(0);
    const repo = t.repos.getByFullName("github", "acme/web-app")!;
    t.repos.update(repo.id, { forks: "never" });
    expect(await t.service.handle(updated(fork))).toMatchObject({ action: "ignored", reason: expect.stringContaining("never previewed") });
    t.repos.update(repo.id, { forks: "auto", visibility: "private" });
    expect(await t.service.handle(updated(fork))).toMatchObject({ action: "deployed" });
    expect(t.deploys[0]!.visibility).toBe("public");
  });

  test("a draft is ignored unless the repository opts in", async () => {
    const t = make();
    expect(await t.service.handle(updated(pull({ draft: true })))).toMatchObject({ action: "ignored", reason: "#123 is a draft" });
    const repo = t.repos.getByFullName("github", "acme/web-app")!;
    t.repos.update(repo.id, { drafts: true });
    expect(await t.service.handle(updated(pull({ draft: true })))).toMatchObject({ action: "deployed" });
  });

  test("`/preview deploy` from a collaborator builds a fork PR, public; from a contributor it is silently ignored", async () => {
    const fork = pull({ fromFork: true, headSha: "c".repeat(40) });
    const t = make({ prs: { 123: fork } });
    expect(await t.service.handle(command("deploy", "other"))).toMatchObject({ action: "ignored", reason: expect.stringContaining("(other)") });
    expect(t.comments.size).toBe(0);
    expect(t.deploys).toHaveLength(0);
    expect(await t.service.handle(command("deploy", "collaborator"))).toMatchObject({ action: "deployed", name: "web-app-pr-123" });
    expect(t.deploys[0]).toMatchObject({ visibility: "public", actor: { kind: "forge", login: "maintainer" }, source: { sha: "c".repeat(40) } });
  });

  test("`/preview deploy` on a fork under `never` answers the maintainer and builds nothing", async () => {
    const t = make({ prs: { 123: pull({ fromFork: true }) } });
    t.service.register(ghRepo());
    t.repos.update(t.repos.getByFullName("github", "acme/web-app")!.id, { forks: "never" });
    expect(await t.service.handle(command("deploy", "owner"))).toEqual({ action: "commented", previewId: null });
    expect([...t.comments.values()][0]).toContain("never previewed");
    expect(t.deploys).toHaveLength(0);
  });
});

describe("/preview commands", () => {
  test("status with no preview says so; status with one reports its state and URL in the SAME comment", async () => {
    const t = make({ prs: { 123: pull() } });
    expect(await t.service.handle(command("status"))).toEqual({ action: "commented", previewId: null });
    expect(t.comments.get(1)).toContain("No preview exists");
    const out = await t.service.handle(updated());
    if (out.action !== "deployed") throw new Error();
    t.settle("P1", "awake"); await out.settled;
    expect(await t.service.handle(command("status", "member"))).toEqual({ action: "commented", previewId: "P1" });
    expect(t.comments.size).toBe(2); // the status comment from before the preview existed, plus the sticky one
    expect(t.comments.get(2)).toContain("Preview is **awake**");
    expect(t.comments.get(2)).toContain("https://web-app-pr-123-p1x.preview.example.com/");
  });

  test("redeploy rebuilds the same head; destroy tears down", async () => {
    const t = make({ prs: { 123: pull() } });
    const out = await t.service.handle(updated());
    if (out.action !== "deployed") throw new Error();
    t.settle("P1", "awake"); await out.settled;
    expect(await t.service.handle(command("redeploy"))).toMatchObject({ action: "deployed", previewId: "P2" });
    expect(t.destroys.map((d) => d.id)).toEqual(["P1"]);
    expect(await t.service.handle(command("destroy", "owner"))).toEqual({ action: "destroyed", previewId: "P2" });
    expect(t.comments.get(1)).toContain("destroyed on request");
    expect(await t.service.handle(command("destroy", "owner"))).toMatchObject({ action: "ignored", reason: "#123 has no preview to destroy" });
  });
});

describe("repositories", () => {
  test("a second repository whose slug is taken is registered DISABLED with the reason, and its PRs are ignored until the operator fixes it", async () => {
    const t = make();
    await t.service.handle(updated());
    const other = pull({ repo: ghRepo({ fullName: "other/web-app", owner: "other", installationId: "1" }) });
    expect(await t.service.handle(updated(other))).toMatchObject({ action: "ignored", reason: expect.stringContaining('slug "web-app" is taken by acme/web-app') });
    const row = t.repos.getByFullName("github", "other/web-app")!;
    expect(row).toMatchObject({ enabled: false });
    expect(row.slug).toMatch(/^web-app-[0-9a-z]{6}$/);
    t.repos.update(row.id, { slug: "legacy", enabled: true, disabledReason: null });
    expect(await t.service.handle(updated(other))).toMatchObject({ action: "deployed", name: "legacy-pr-123" });
  });

  test("an installation id that moved is updated on the row; a disabled repository stays disabled", async () => {
    const t = make();
    await t.service.handle(updated());
    const row = t.repos.getByFullName("github", "acme/web-app")!;
    t.repos.update(row.id, { enabled: false, disabledReason: "paused" });
    expect(await t.service.handle(updated(pull({ repo: ghRepo({ installationId: "9" }) })))).toMatchObject({ action: "ignored", reason: "acme/web-app is disabled: paused" });
    expect(t.repos.get(row.id)).toMatchObject({ installationId: "9", enabled: false });
  });

  test("slugFor: slugified, capped, never empty", () => {
    expect(slugFor("Web App")).toBe("web-app");
    expect(slugFor("a-very-long-repository-name-that-goes-on-and-on")).toHaveLength(MAX_REPO_SLUG);
    expect(slugFor("a-very-long-repository-name-that-goes-on-and-on")).not.toMatch(/-$/);
    expect(slugFor("___")).toBe("repo");
  });
});
