import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors.ts";
import { Logger } from "../../src/logger.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { fixedPolicy, PolicyResolver, triggerOf, type Policy } from "../../src/previews/policy.ts";
import { TemplatesRepo } from "../../src/db/repos/templates.ts";
import { ProjectsRepo } from "../../src/db/repos/projects.ts";
import type { Project, Template } from "@gangway/shared/domain";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

const USER = {
  kind: "user",
  userId: "u1",
  roleId: "admin",
  permissions: new Set(),
  sessionId: "s",
} as const;
const FORGE = { kind: "forge", forge: "github", login: "octocat", permissions: new Set() } as const;
const IMAGE = { kind: "image", image: "traefik/whoami:v1.10", port: 80 } as const;
const PR = {
  kind: "pr",
  repo: "acme/web",
  number: 1,
  sha: "a".repeat(40),
  cloneUrl: "https://github.com/acme/web.git",
  credential: undefined,
} as const;

describe("triggerOf", () => {
  test("a PR source is `pr` from anyone, a session user `manual`, and a token `api`", () => {
    expect(triggerOf(PR as never, FORGE as never)).toBe("pr");
    expect(triggerOf(IMAGE as never, USER as never)).toBe("manual");
    expect(triggerOf(IMAGE as never, ACTOR)).toBe("api");
    expect(
      triggerOf(
        { kind: "git", repo: "https://github.com/acme/web.git", ref: "main" } as never,
        ACTOR,
      ),
    ).toBe("api");
  });
});

describe("PolicyResolver", () => {
  const setup = () => {
    const s = setupPreviewContext();
    const templates = new TemplatesRepo(s.db);
    const repos = new ProjectsRepo(s.db);
    templates.create({ id: "staging", name: "Staging", visibility: "private", clearance: "high" });
    templates.create({ id: "ci", name: "CI", ttl: "1h" });
    const defaults: Record<string, string> = { pr: "default", api: "ci", manual: "default" };
    const lines: string[] = [];
    const policy = new PolicyResolver({
      templates,
      defaultFor: (t) => defaults[t]!,
      logger: new Logger("warn", {}, (l) => lines.push(l)),
      project: (ref) => repos.find(ref),
      projectForSource: (source) =>
        source.kind === "pr" ? repos.getByFullName("github", source.repo) : undefined,
    });
    return { s, templates, repos, defaults, policy, lines };
  };

  test("the request's template wins, and an unknown one is a 422 rather than a fallback", () => {
    const { policy } = setup();
    expect(policy.resolve({ source: IMAGE, actor: ACTOR, template: "staging" }).template.id).toBe(
      "staging",
    );
    expect(() => policy.resolve({ source: IMAGE, actor: ACTOR, template: "ghost" })).toThrow(
      AppError,
    );
  });

  test("uses the trigger's default unless the repository names a template", () => {
    const { policy, repos } = setup();
    expect(policy.resolve({ source: IMAGE, actor: ACTOR }).template.id).toBe("ci");
    expect(policy.resolve({ source: IMAGE, actor: USER as never }).template.id).toBe("default");
    const repo = repos.create({
      id: "r1",
      name: "web",
      forge: "github",
      fullName: "acme/web",
      installationId: "1",
      slug: "web",
    });
    const resolved = policy.resolve({ source: PR, actor: FORGE as never });
    expect(resolved).toMatchObject({
      template: { id: "default" },
      project: { id: "r1" },
      trigger: "pr",
    });
    repos.update(repo.id, { templateId: "staging" });
    expect(policy.resolve({ source: PR, actor: FORGE as never }).template.id).toBe("staging");
  });

  test("a stale trigger default falls back to `default` and is logged once", () => {
    const { policy, defaults, lines } = setup();
    defaults["api"] = "gone";
    expect(policy.resolve({ source: IMAGE, actor: ACTOR }).template.id).toBe("default");
    expect(policy.resolve({ source: IMAGE, actor: ACTOR }).template.id).toBe("default");
    expect(lines.filter((l) => l.includes("template not found"))).toHaveLength(1);
  });

  test("a project named by id or slug wins over the source's; an unknown one is a 422", () => {
    const { policy, repos } = setup();
    repos.create({
      id: "r1",
      name: "web",
      forge: "github",
      fullName: "acme/web",
      slug: "web",
      templateId: "staging",
    });
    repos.create({ id: "r2", name: "ci box", slug: "ci-box", templateId: "ci" });
    expect(policy.resolve({ source: IMAGE, actor: ACTOR, projectId: "ci-box" })).toMatchObject({
      project: { id: "r2" },
      template: { id: "ci" },
    });
    expect(policy.resolve({ source: PR, actor: FORGE as never, projectId: "r2" }).project?.id).toBe(
      "r2",
    );
    expect(() => policy.resolve({ source: IMAGE, actor: ACTOR, projectId: "ghost" })).toThrow(
      AppError,
    );
  });
});

describe("deploy follows the template", () => {
  const withRepo = (fields: Partial<Template>, repo?: Partial<Project>): Policy => {
    const base = fixedPolicy(fields);
    const full: Project | undefined = repo && {
      id: "r1",
      name: "web",
      forge: "github",
      fullName: "acme/web",
      installationId: "1",
      prTrigger: "workflow",
      slug: "web",
      enabled: true,
      disabledReason: null,
      templateId: null,
      visibility: null,
      ttl: null,
      prClearance: null,
      forks: "ask",
      drafts: false,
      forkClearance: "none",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...repo,
    };
    return { resolve: (i) => ({ ...base.resolve(i), project: full }), default: base.default };
  };

  test("takes visibility, ttl, idle, clearance and host from the template it records", async () => {
    const s = setupPreviewContext();
    s.ctx.policy = withRepo({
      id: "staging",
      visibility: "private",
      ttl: null,
      idleAfter: "10m",
      clearance: "high",
      hostId: "local",
    });
    const asked: [string | null, string][] = [];
    s.ctx.secretsFor = (repoId, clearance) => {
      asked.push([repoId, clearance]);
      return {};
    };
    const p = await (await deploy(s.ctx, { actor: ACTOR, name: "tpl", source: IMAGE })).done;
    expect(p).toMatchObject({
      visibility: "private",
      ttlExpiresAt: null,
      idleAfterMs: 600_000,
      secretLevel: "high",
      templateId: "staging",
      hostId: "local",
      projectId: null,
    });
    expect(asked).toEqual([[null, "high"]]);
  });

  test("the repository overrides the template, and the request overrides both", async () => {
    const s = setupPreviewContext();
    new ProjectsRepo(s.db).create({
      id: "r1",
      name: "web",
      slug: "web",
      forge: "github",
      fullName: "acme/web",
    });
    s.ctx.policy = withRepo(
      { visibility: "public", ttl: "7d", clearance: "standard" },
      { visibility: "private", ttl: "2h", prClearance: "low" },
    );
    const asked: [string | null, string][] = [];
    s.ctx.secretsFor = (repoId, clearance) => {
      asked.push([repoId, clearance]);
      return {};
    };
    const a = await (await deploy(s.ctx, { actor: ACTOR, name: "over", source: IMAGE })).done;
    expect(a).toMatchObject({ visibility: "private", secretLevel: "low", projectId: "r1" });
    expect(a.ttlExpiresAt!.getTime() - s.ctx.now()).toBeLessThanOrEqual(2 * 3_600_000);
    expect(asked).toEqual([["r1", "low"]]);
    const b = await (
      await deploy(s.ctx, {
        actor: ACTOR,
        name: "req",
        source: IMAGE,
        visibility: "public",
        ttl: null,
        secretLevel: "none",
      })
    ).done;
    expect(b).toMatchObject({ visibility: "public", ttlExpiresAt: null, secretLevel: "none" });
  });

  test("a template naming a missing host is placed by the scheduler, not refused", async () => {
    const s = setupPreviewContext();
    s.ctx.policy = withRepo({ hostId: "mars" });
    const p = await (await deploy(s.ctx, { actor: ACTOR, name: "stale", source: IMAGE })).done;
    expect(p.state).toBe("awake");
    expect(p.hostId).toBe("local");
    await expect(
      deploy(s.ctx, { actor: ACTOR, name: "typo", source: IMAGE, hostId: "mars" }),
    ).rejects.toThrow(/does not exist/);
  });
});
