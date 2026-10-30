import { describe, expect, test } from "bun:test";
import { deploy } from "../../src/previews/deploy.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { tarball } from "../helpers/runtimes-fixtures.ts";

const COMPOSE = `services:
  web:
    build:
      context: .
      secrets: [npm]
    x-gangway: { expose: true, port: 3000 }
secrets:
  npm:
    environment: NPM_TOKEN
`;

const start = async (s: ReturnType<typeof setupPreviewContext>, env: Record<string, string>) =>
  deploy(s.ctx, {
    actor: ACTOR,
    visibility: "public",
    name: "npm",
    env,
    source: {
      kind: "tarball",
      archive: await tarball({ "compose.yaml": COMPOSE, Dockerfile: "FROM node" }),
    },
  });

describe("BuildKit secrets", () => {
  test("only the build gets the secret it names, and the log never shows it", async () => {
    const s = setupPreviewContext();
    const res = await start(s, { NPM_TOKEN: "npm_live_123", OTHER: "x" });
    expect(await res.done).toMatchObject({ state: "awake" });
    expect(s.fake.buildEnvs).toEqual([{ NPM_TOKEN: "npm_live_123" }]);
    const log = s.ctx.logs.tail(res.preview.id).join("\n");
    expect(log).toContain("the build gets 1 secret(s) as BuildKit secrets");
    expect(log).not.toContain("npm_live_123");
  });

  test("a secret the preview does not have refuses the deploy before any build", async () => {
    const s = setupPreviewContext();
    await expect(start(s, { OTHER: "x" })).rejects.toMatchObject({
      detail: { violations: ['secret "npm": NPM_TOKEN is not one of the preview\'s secrets'] },
    });
    await Bun.sleep(0);
    expect(s.fake.builds).toBe(0);
  });
});
