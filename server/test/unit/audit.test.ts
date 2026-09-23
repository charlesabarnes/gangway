import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { auditRoutes } from "../../src/app/routes/audit.ts";
import { Audit } from "../../src/audit/audit.ts";
import { systemActor, tokenActor, type Actor } from "../../src/auth/actor.ts";
import type { AuditRepo } from "../../src/db/repos/index.ts";
import { Logger } from "../../src/logger.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { sweepExpired } from "../../src/scheduler/jobs.ts";
import { ACTOR, setupPreviewContext as setup } from "../helpers/preview-context.ts";
import { silentLogger } from "../helpers/logger.ts";

const quiet = silentLogger();
const all = (repo: AuditRepo) => repo.page({ limit: 200 }).entries;

describe("the audit log is written by the service layer", () => {
  test("a deploy is recorded once the rows exist, with who, what and where", async () => {
    const s = setup();
    const preview = await s.deployed("audited");
    expect(all(s.audit)).toEqual([
      expect.objectContaining({
        actorType: "token",
        actorId: "env:admin",
        action: "preview.deploy",
        target: preview.id,
        old: null,
        new: {
          project: "gw-default-audited",
          visibility: "public",
          passwordMode: "inherit",
          source: "image",
          hostId: preview.hostId,
          urls: ["https://audited.preview.localhost:8443/"],
        },
      }),
    ]);
  });

  test("a rejected deploy made nothing, so it records nothing", async () => {
    const s = setup();
    await expect(s.deployed("Not A Valid Name !!".repeat(10))).rejects.toBeDefined();
    expect(all(s.audit)).toEqual([]);
  });

  test("a destroy records what the preview WAS, and a user is a user", async () => {
    const s = setup();
    const preview = await s.deployed("doomed");
    const user: Actor = {
      kind: "user",
      userId: "u-ada",
      roleId: "member",
      permissions: new Set(["previews.destroy"]),
      sessionId: "sess",
    };
    await destroy(s.ctx, preview.id, user);
    expect(all(s.audit)[0]).toMatchObject({
      actorType: "user",
      actorId: "u-ada",
      action: "preview.destroy",
      target: preview.id,
      old: { project: "gw-default-doomed", state: "awake", hostId: preview.hostId },
      new: null,
    });
  });

  test("the TTL sweep's destroy is recorded as the system's, not as nobody's", async () => {
    const s = setup();
    const preview = await s.deployed("expiring");
    s.db.run("UPDATE previews SET ttl_expires_at = $t WHERE id = $id", {
      t: Date.now() - 1000,
      id: preview.id,
    });
    await sweepExpired(s.ctx, s.logger);
    expect(all(s.audit)[0]).toMatchObject({
      actorType: "system",
      actorId: "ttl-sweep",
      action: "preview.destroy",
      target: preview.id,
    });
  });
});

describe("Audit.record", () => {
  test("redacts on the way in -- a token in a value, a secret-named field, nested", () => {
    const s = setup();
    new Audit(s.audit, quiet).record(ACTOR, "token.created", "t1", {
      new: {
        name: "ci",
        note: "use gw_0123456789abcdefghij to deploy",
        password: "hunter2hunter2",
        nested: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
      },
    });
    const stored = JSON.stringify(all(s.audit)[0]);
    expect(stored).not.toContain("gw_0123456789abcdefghij");
    expect(stored).not.toContain("hunter2");
    expect(stored).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(all(s.audit)[0]!.new).toMatchObject({
      name: "ci",
      password: "[redacted]",
      nested: { authorization: "[redacted]" },
    });
  });

  test("a field NAMED `key` is swallowed by redaction: settings changes must say `setting`", () => {
    const s = setup();
    const audit = new Audit(s.audit, quiet);
    audit.record(ACTOR, "user.updated", null, {
      new: { key: "surfaces.ui", setting: "surfaces.ui" },
    });
    expect(all(s.audit)[0]!.new).toEqual({ key: "[redacted]", setting: "surfaces.ui" });
  });

  test("nobody authenticated (a failed login) is `system` with no id; the target says who it was about", () => {
    const s = setup();
    new Audit(s.audit, quiet).record(null, "auth.login.failed", "ada@example.com", {
      new: { ip: "203.0.113.7" },
    });
    expect(all(s.audit)[0]).toMatchObject({
      actorType: "system",
      actorId: null,
      target: "ada@example.com",
      new: { ip: "203.0.113.7" },
    });
  });

  test("never throws: the action already happened, so a failed write is logged, not raised", () => {
    const lines: string[] = [];
    const broken = {
      append: () => {
        throw new Error("disk full");
      },
    } as unknown as AuditRepo;
    const audit = new Audit(broken, new Logger("error", {}, (l) => lines.push(l)));
    expect(() => audit.record(systemActor("x"), "preview.destroy", "p1")).not.toThrow();
    expect(lines.join("\n")).toContain("audit write failed");
    expect(lines.join("\n")).toContain("disk full");
  });
});

describe("GET /v1/audit", () => {
  const app = (repo: AuditRepo, actor: Actor) => {
    const api = new Hono<AppEnv>();
    api.onError(errorHandler(quiet));
    api.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", actor);
      return next();
    });
    auditRoutes(api, repo);
    return (path: string) => api.request(path);
  };

  test("needs audit.read: a deploy-scoped token is refused", async () => {
    const s = setup();
    expect((await app(s.audit, tokenActor("ci", ["deploy"]))("/audit")).status).toBe(403);
    expect((await app(s.audit, ACTOR)("/audit")).status).toBe(200);
  });

  test("pages newest-first; nextBefore walks to the end; limit is capped", async () => {
    const s = setup();
    const audit = new Audit(s.audit, quiet);
    for (let i = 1; i <= 5; i++) audit.record(ACTOR, "auth.login", `u${i}`);
    const get = app(s.audit, ACTOR);

    const first = (await (await get("/audit?limit=2")).json()) as {
      entries: { target: string }[];
      nextBefore: number | null;
    };
    expect(first.entries.map((e) => e.target)).toEqual(["u5", "u4"]);
    const rest = (await (
      await get(`/audit?limit=10&before=${first.nextBefore}`)
    ).json()) as typeof first;
    expect(rest.entries.map((e) => e.target)).toEqual(["u3", "u2", "u1"]);
    expect(rest.nextBefore).toBeNull();

    expect((await get("/audit?limit=5000")).status).toBe(422);
    expect(
      ((await (await get("/audit?action=preview.deploy")).json()) as typeof first).entries,
    ).toEqual([]);
  });
});
