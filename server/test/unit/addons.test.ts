/** ADR-0017: add-ons -- throwaway databases as sidecars that survive rebuilds and die with the preview. */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { dirname } from "node:path";
import { pack } from "tar-stream";
import { planApp } from "@gangway/shared/app-plan";
import { TarballDeployQuerySchema } from "@gangway/shared/api";
import { renderAddons } from "../../src/previews/addons.ts";
import { buildStack, parseComposeModel } from "../../src/previews/compose-model.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { redeploy } from "../../src/previews/redeploy.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

async function tarball(files: Record<string, string>): Promise<Uint8Array> {
  const p = pack();
  for (const [name, content] of Object.entries(files)) p.entry({ name }, content);
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const c of p) chunks.push(c as Buffer);
  return gzipSync(Buffer.concat(chunks));
}

function setup() {
  const s = setupPreviewContext();
  s.ctx.sources = new SourceStore(dirname(s.ctx.workdirs.root));
  return { ...s, sources: s.ctx.sources };
}

type Svc = {
  image?: string;
  build?: unknown;
  ports?: unknown;
  labels: Record<string, string>;
  environment: Record<string, string>;
  healthcheck?: { test: string[] };
  depends_on?: unknown;
};
const services = (stack: Record<string, unknown>) => stack["services"] as Record<string, Svc>;
const pkg = (deps: Record<string, string>) =>
  JSON.stringify({ scripts: { start: "node s.js" }, dependencies: deps });

describe("the plan", () => {
  const plan = (
    files: Record<string, string>,
    extra: Parameters<typeof planApp>[0] extends infer T ? Partial<T> : never = {},
  ) => planApp({ paths: Object.keys(files), files, ...extra });

  test("suggested from drivers, never chosen by the server", () => {
    const p = plan({ "package.json": pkg({ pg: "8", ioredis: "5" }) });
    expect(p.addons).toEqual([]);
    expect(p.suggested).toEqual([
      { id: "postgres", because: "pg" },
      { id: "redis", because: "ioredis" },
    ]);
    expect(
      plan({ "requirements.txt": "psycopg[binary]>=3\nredis\n", "main.py": "" }).suggested.map(
        (s) => s.id,
      ),
    ).toEqual(["postgres", "redis"]);
    // An ORM is not a driver.
    expect(plan({ "package.json": pkg({ "@prisma/client": "6" }) }).suggested).toEqual([]);
  });

  test("the request beats gangway.yml; gangway.yml beats the previous build; versions from the allowlist", () => {
    const files = {
      "package.json": pkg({}),
      "gangway.yml": "addons: [postgres, { id: redis, version: 8 }]\n",
    };
    expect(plan(files).addons).toEqual([
      { id: "postgres", version: "18" },
      { id: "redis", version: "8" },
    ]);
    expect(plan(files, { addons: [] }).addons).toEqual([]);
    expect(
      plan({ "package.json": pkg({}) }, { previousAddons: [{ id: "postgres", version: "17" }] })
        .addons,
    ).toEqual([{ id: "postgres", version: "17" }]);
    expect(
      plan({ "package.json": pkg({}), "gangway.yml": "addons: [{ id: postgres, version: 9 }]\n" })
        .issues,
    ).toEqual([{ path: "addons", message: "PostgreSQL offers 16, 17, 18" }]);
  });

  test("a major is never changed in place; removing one says its data stays", () => {
    const up = plan(
      { "package.json": pkg({}), "gangway.yml": "addons: [{ id: postgres, version: 18 }]\n" },
      { previousAddons: [{ id: "postgres", version: "17" }] },
    );
    expect(up.reasons.find((r) => r.level === "error")?.then).toContain(
      "new major version needs a new preview",
    );
    const gone = plan(
      { "package.json": pkg({}), "gangway.yml": "addons: []\n" },
      { previousAddons: [{ id: "redis", version: "8" }] },
    );
    expect(gone.addons).toEqual([]);
    expect(
      gone.reasons.some(
        (r) => r.level === "warn" && r.then.includes("data is kept until the preview is destroyed"),
      ),
    ).toBe(true);
  });

  test("seed.sql goes to the first SQL add-on; a compose upload may not ask for add-ons", () => {
    expect(
      plan({ "package.json": pkg({}), "db/seed.sql": "" }, { addons: ["redis", "postgres"] })
        .sqlSeed,
    ).toBe("db/seed.sql");
    expect(
      plan({ "package.json": pkg({}), "seed.sql": "" }, { addons: ["redis"] }).sqlSeed,
    ).toBeNull();
    expect(
      plan({ "compose.yaml": "" }, { addons: ["postgres"] }).reasons.some(
        (r) => r.level === "error",
      ),
    ).toBe(true);
  });
});

describe("rendering", () => {
  const pw = (id: string) => `secret-${id}-0123456789`;

  test("postgres: pinned image, TCP healthcheck, a volume, env for the app", () => {
    const r = renderAddons([{ id: "postgres", version: "18" }], pw, null);
    const pg = r.services["postgres"]!;
    expect(pg["image"]).toBe("postgres:18-alpine");
    expect(pg["ports"]).toBeUndefined();
    expect((pg["healthcheck"] as { test: string[] }).test).toEqual([
      "CMD",
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "app",
      "-d",
      "app",
    ]);
    expect(pg["volumes"]).toEqual([
      { type: "volume", source: "postgres-data", target: "/var/lib/postgresql" },
    ]);
    expect(r.appEnv["DATABASE_URL"]).toBe(
      "postgres://app:secret-postgres-0123456789@postgres:5432/app",
    );
    expect(r.dependsOn).toEqual({ postgres: { condition: "service_healthy" } });
    expect(r.secrets).toEqual(["secret-postgres-0123456789"]);
  });

  test("a seed is baked into a derived image built from the app's root, its context cut down to the file", () => {
    const r = renderAddons([{ id: "mysql", version: "8.4" }], pw, "db/seed.sql", "site");
    expect(r.services["mysql"]!["build"]).toEqual({
      context: "site",
      dockerfile: ".gangway/mysql.Dockerfile",
    });
    expect(r.files["mysql.Dockerfile"]).toContain(
      `COPY ["db/seed.sql","/docker-entrypoint-initdb.d/10-seed.sql"]`,
    );
    expect(r.files["mysql.Dockerfile.dockerignore"]).toBe("*\n!db/seed.sql\n");
    expect(r.appEnv["DATABASE_URL"]).toStartWith("mysql://app:");
  });

  test("redis reads its password from its own environment, escaped for compose", () => {
    const r = renderAddons([{ id: "redis", version: "8" }], pw, null);
    expect(JSON.stringify(r.services["redis"])).toContain("$$REDIS_PASSWORD");
    expect(JSON.stringify(r.services["redis"])).not.toContain("--requirepass secret");
    expect(r.appEnv["REDIS_URL"]).toBe("redis://:secret-redis-0123456789@redis:6379/0");
  });

  test("byte-stable: the same inputs render the same sidecar (anything else recreates the database on every save)", () => {
    const a = renderAddons(
      [
        { id: "postgres", version: "18" },
        { id: "redis", version: "8" },
      ],
      pw,
      "seed.sql",
    );
    const b = renderAddons(
      [
        { id: "postgres", version: "18" },
        { id: "redis", version: "8" },
      ],
      pw,
      "seed.sql",
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("deploying with add-ons", () => {
  test("the stack runs a postgres sidecar: ownership labels only, NO ports, the app waits for it and is told where it is", async () => {
    const s = setup();
    const archive = await tarball({
      "package.json": pkg({ pg: "8" }),
      "s.js": "",
      "seed.sql": "create table t(x int);",
    });
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      name: "db",
      visibility: "public",
      source: { kind: "tarball", archive, runtime: "auto", addons: ["postgres"] },
    });
    expect((await res.done).state).toBe("awake");
    expect(res.preview.source).toEqual({
      kind: "tarball",
      uploadId: res.preview.id,
      runtime: "node",
      addons: [{ id: "postgres", version: "18" }],
    });

    const svc = services(s.fake.stacks[0]!);
    expect(Object.keys(svc).sort()).toEqual(["postgres", "web"]);
    expect(svc["postgres"]!.ports).toBeUndefined();
    expect(svc["postgres"]!.labels["gangway.managed"]).toBeUndefined();
    expect(svc["postgres"]!.labels["gangway.preview_id"]).toBe(res.preview.id);
    expect(svc["postgres"]!.build).toMatchObject({ dockerfile: ".gangway/postgres.Dockerfile" });
    expect(svc["web"]!.depends_on).toEqual({ postgres: { condition: "service_healthy" } });
    const pw = s.ctx.addonSecret!(res.preview.id, "postgres");
    expect(svc["web"]!.environment["DATABASE_URL"]).toBe(`postgres://app:${pw}@postgres:5432/app`);
    expect(
      (s.fake.stacks[0]!["volumes"] as Record<string, unknown>)["postgres-data"],
    ).toBeDefined();
    // The password never reaches the log.
    s.ctx.logs.append(res.preview.id, "stdout", `connecting with ${pw}`);
    expect(
      s.ctx.logs
        .read(res.preview.id)
        .map((l) => l.line)
        .join("\n"),
    ).not.toContain(pw);
  });

  test("two plans of the same preview give byte-identical sidecars (compose would otherwise recreate the database)", async () => {
    const s = setup();
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      name: "stable",
      visibility: "public",
      source: {
        kind: "tarball",
        archive: await tarball({ "index.ts": "v1" }),
        runtime: "bun",
        addons: ["postgres", "redis"],
      },
    });
    const p = await res.done;
    await (
      await redeploy(s.ctx, {
        actor: ACTOR,
        previewId: p.id,
        change: { kind: "edit", files: { "index.ts": "v2" } },
      })
    ).done;
    const [a, b] = s.fake.stacks.slice(-2).map((st) => services(st));
    expect(JSON.stringify(a!["postgres"])).toBe(JSON.stringify(b!["postgres"]));
    expect(JSON.stringify(a!["redis"])).toBe(JSON.stringify(b!["redis"]));
  });

  test("a rebuild starts the add-ons first, alone, then the release, then swaps", async () => {
    const s = setup();
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      name: "order",
      visibility: "public",
      source: {
        kind: "tarball",
        archive: await tarball({
          "index.ts": "v1",
          "gangway.yml": "addons: [postgres]\nrelease: npm run migrate\n",
        }),
        runtime: "bun",
      },
    });
    const p = await res.done;
    const from = s.fake.all.length;
    await (
      await redeploy(s.ctx, {
        actor: ACTOR,
        previewId: p.id,
        change: { kind: "edit", files: { "index.ts": "v2" } },
      })
    ).done;
    const steps = s.fake.all
      .slice(from)
      .map((a) =>
        a.includes("up")
          ? `up ${a
              .slice(a.indexOf("up") + 1)
              .filter((x) => !x.startsWith("-"))
              .join(" ")}`.trim()
          : a.includes("run")
            ? "run"
            : a.includes("build")
              ? "build"
              : null,
      )
      .filter(Boolean);
    expect(steps).toEqual(["build", "up postgres", "run", "up"]);
  });

  test("a failed rebuild keeps volumes; destroy removes them, including any the containers no longer point at", async () => {
    const s = setup();
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      name: "vols",
      visibility: "public",
      source: {
        kind: "tarball",
        archive: await tarball({ "index.ts": "v1" }),
        runtime: "bun",
        addons: ["postgres"],
      },
    });
    const p = await res.done;
    s.fake.answering = false;
    await (
      await redeploy(s.ctx, {
        actor: ACTOR,
        previewId: p.id,
        change: { kind: "edit", files: { "index.ts": "v2" } },
      })
    ).done;
    const salvage = s.fake.downArgvs.at(-1)!;
    expect(salvage).not.toContain("-v");
    expect(salvage).toContain("--remove-orphans");
    await destroy(s.ctx, p.id, ACTOR);
    expect(s.fake.downArgvs.at(-1)).toContain("-v");
    expect(
      s.fake.all.some(
        (a) =>
          a.includes("volume") &&
          a.includes("ls") &&
          a.includes(`label=com.docker.compose.project=${p.project}`),
      ),
    ).toBe(true);
  });

  test("changing a major in place is refused and changes nothing; removing an add-on is recorded", async () => {
    const s = setup();
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      name: "major",
      visibility: "public",
      source: {
        kind: "tarball",
        archive: await tarball({ "index.ts": "v1" }),
        runtime: "bun",
        addons: [{ id: "postgres", version: "17" }],
      },
    });
    const p = await res.done;
    await expect(
      redeploy(s.ctx, {
        actor: ACTOR,
        previewId: p.id,
        addons: [{ id: "postgres", version: "18" }],
        change: { kind: "edit", files: {} },
      }),
    ).rejects.toMatchObject({
      code: "unprocessable",
      message: expect.stringContaining("new major"),
    });
    expect(s.previews.get(p.id)!.source).toMatchObject({
      addons: [{ id: "postgres", version: "17" }],
    });
    await (
      await redeploy(s.ctx, {
        actor: ACTOR,
        previewId: p.id,
        addons: [],
        change: { kind: "edit", files: {} },
      })
    ).done;
    expect(s.previews.get(p.id)!.source).toEqual({
      kind: "tarball",
      uploadId: p.id,
      runtime: "bun",
    });
  });

  test("no key, no add-ons", async () => {
    const s = setup();
    s.ctx.addonSecret = undefined;
    await expect(
      deploy(s.ctx, {
        actor: ACTOR,
        name: "nokey",
        visibility: "public",
        source: {
          kind: "tarball",
          archive: await tarball({ "index.ts": "" }),
          runtime: "bun",
          addons: ["redis"],
        },
      }),
    ).rejects.toMatchObject({ code: "internal" });
  });
});

test("?addons= parses ids, @majors and none", () => {
  expect(TarballDeployQuerySchema.parse({ addons: "postgres,redis@8" }).addons).toEqual([
    { id: "postgres" },
    { id: "redis", version: "8" },
  ]);
  expect(TarballDeployQuerySchema.parse({ addons: "none" }).addons).toEqual([]);
  expect(() => TarballDeployQuerySchema.parse({ addons: "mongo" })).toThrow();
  expect(() => TarballDeployQuerySchema.parse({ addons: "redis,redis" })).toThrow();
});

test("a user's compose sidecar keeps its ports deleted and gets ownership labels (unchanged by ADR-0017)", () => {
  const resolved = {
    services: {
      web: { image: "x", ports: [{ target: 80, protocol: "tcp" }] },
      db: { image: "postgres", ports: [{ target: 5432, published: "5432", protocol: "tcp" }] },
    },
  };
  const model = parseComposeModel("gw-plan", resolved);
  const stack = JSON.parse(
    buildStack({
      resolved,
      planProject: "gw-plan",
      model,
      createdAt: new Date(0),
      publishBind: "127.0.0.1",
      origin: { scheme: "https", port: 443 },
      routes: [
        {
          hostname: "a.x",
          previewId: "01M3640JNMEMQG6V75PVJTCBTP",
          service: "web",
          containerPort: 80,
          upstream: { host: "127.0.0.1", port: 31000 },
          primary: true,
        },
      ],
      ctx: { instance: "i", env: "e", project: "gw-i-a", hostId: "local", visibility: "public" },
    }),
  );
  expect(stack.services.db.ports).toBeUndefined();
  expect(stack.services.db.labels["gangway.managed"]).toBeUndefined();
});
