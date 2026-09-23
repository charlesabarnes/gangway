import type { Preview } from "@gangway/shared/domain";
import type { Actor } from "../../src/auth/actor.ts";
import type { DeploymentState, Forge, ForgeRepo, PullRequest } from "../../src/forge/forge.ts";
import type { DeployInput, DeployResult, PreviewUrl } from "../../src/previews/deploy-types.ts";

export const ghRepo = (over: Partial<ForgeRepo> = {}): ForgeRepo => ({
  forge: "github",
  fullName: "acme/web-app",
  owner: "acme",
  name: "web-app",
  cloneUrl: "https://github.com/acme/web-app.git",
  installationId: "4242",
  private: false,
  ...over,
});
export const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: ghRepo(),
  number: 123,
  title: "Add the thing",
  headSha: "a".repeat(40),
  headRef: "feature",
  baseRef: "main",
  fromFork: false,
  draft: false,
  author: "dev",
  htmlUrl: "https://github.com/acme/web-app/pull/123",
  ...over,
});

type Deployment = {
  id: number;
  env: string;
  sha: string;
  statuses: { state: DeploymentState; environmentUrl?: string; logUrl?: string }[];
};

/** A forge that remembers what it was told. */
export function fakeForge(o: { commentsFail?: boolean; prs?: Record<number, PullRequest> } = {}) {
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
    async cloneCredential(repo) {
      credentials.push(repo.installationId);
      return `ghs_${repo.installationId}`;
    },
    async upsertComment(_pr, existingId, body) {
      if (o.commentsFail) throw new Error("GitHub is down");
      const id = existingId !== null && comments.has(existingId) ? existingId : nextComment++;
      comments.set(id, body);
      return id;
    },
    async createDeployment(pr, env) {
      const id = 500 + deployments.length;
      deployments.push({ id, env, sha: pr.headSha, statuses: [] });
      return id;
    },
    async setDeploymentStatus(_repo, id, state, extra = {}) {
      deployments.find((d) => d.id === id)!.statuses.push({ state, ...extra });
    },
  };
  return { forge, comments, deployments, credentials };
}

/** A preview service that keeps rows in memory and lets the test settle each deploy. */
export function fakePreviews(instance = "test") {
  const rows = new Map<string, Preview>();
  const refs = new Map<string, { commentId: number | null; deploymentId: number | null }>();
  const deploys: DeployInput[] = [];
  const destroys: { id: string; actor: Actor }[] = [];
  const pending = new Map<string, (final: Preview) => void>();
  let seq = 0;
  const urlsFor = (p: Preview): PreviewUrl[] => [
    {
      service: "web",
      url: `https://${p.project.replace(`gw-${instance}-`, "")}.preview.example.com/`,
      primary: true,
    },
  ];
  void urlsFor;
  const previews = {
    async deploy(input: DeployInput): Promise<DeployResult> {
      deploys.push(input);
      const id = `P${++seq}`;
      // Like deploy.ts: an unlisted preview's name gets an unguessable suffix, so the project is not the PR's stable name.
      const slug =
        (input.visibility ?? "unlisted") === "unlisted"
          ? `${input.name}-${id.toLowerCase()}x`
          : input.name;
      const s = input.source;
      const preview: Preview = {
        id,
        project: `gw-${instance}-${slug}`,
        title: null,
        hostId: "local",
        kind: "preview",
        state: "building",
        source:
          s.kind === "pr"
            ? { kind: "pr", repo: s.repo, number: s.number, sha: s.sha }
            : { kind: "image", image: "x" },
        visibility: input.visibility ?? "unlisted",
        ttlExpiresAt: input.ttl ? new Date(Date.now() + 86_400_000) : null,
        idleAfterMs: null,
        secretLevel: input.secretLevel ?? null,
        templateId: input.template ?? "default",
        projectId: input.projectId ?? null,
        password: "inherit",
        passwordLogin: "inherit",
        lastSeenAt: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        destroyedAt: null,
      };
      rows.set(id, preview);
      const done = new Promise<Preview>((resolve) =>
        pending.set(id, (final) => {
          rows.set(id, final);
          resolve(final);
        }),
      );
      return { preview, urls: urlsFor(preview), done };
    },
    async destroy(id: string, actor: Actor) {
      const p = rows.get(id)!;
      destroys.push({ id, actor });
      const gone = { ...p, state: "destroyed" as const, destroyedAt: new Date() };
      rows.set(id, gone);
      return gone;
    },
    findPullRequest: (repo: string, number: number) =>
      [...rows.values()]
        .reverse()
        .find(
          (p) =>
            p.source.kind === "pr" &&
            p.source.repo === repo &&
            p.source.number === number &&
            p.state !== "destroyed",
        ),
    urls: (id: string) => urlsFor(rows.get(id)!),
    forgeRefs: (id: string) => refs.get(id) ?? { commentId: null, deploymentId: null },
    setForgeRefs: (id: string, r: { commentId?: number | null; deploymentId?: number | null }) => {
      refs.set(id, { ...previews.forgeRefs(id), ...r });
    },
  };
  const settle = (id: string, state: "awake" | "failed", error: string | null = null) => {
    const p = rows.get(id)!;
    pending.get(id)!({ ...p, state, error });
  };
  return { previews, rows, deploys, destroys, settle };
}
