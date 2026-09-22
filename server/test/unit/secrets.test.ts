/** Secrets at rest and the repository env (ADR-0012). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { migrate } from "../../src/db/migrate.ts";
import { ReposRepo } from "../../src/db/repos/repos.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { githubFullName } from "../../src/forge/github/webhook.ts";
import { SecretBox, loadOrCreateSecretsKey } from "../../src/secrets/box.ts";
import { RepoEnv, dotenvLine } from "../../src/secrets/repo-env.ts";

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "gangway-secrets-")); tmps.push(d); return d; };

describe("SecretBox", () => {
  test("seals and opens; a different key or a flipped byte fails closed", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal('{"FONTAWESOME_TOKEN":"fa-abc"}');
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("fa-abc");
    expect(box.open(sealed)).toBe('{"FONTAWESOME_TOKEN":"fa-abc"}');
    expect(box.seal("x")).not.toBe(box.seal("x")); // a fresh iv every time
    expect(() => new SecretBox(randomBytes(32)).open(sealed)).toThrow(/could not be opened/);
    const [v, iv, tag, ct] = sealed.split(".");
    const flipped = Buffer.from(ct!, "base64url"); flipped[0] = flipped[0]! ^ 1;
    expect(() => box.open([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow(/could not be opened/);
    expect(() => box.open("nope")).toThrow(/unknown format/);
  });

  test("the key file is made once, owner-only, and reused", () => {
    const dir = tmp();
    const a = loadOrCreateSecretsKey(dir);
    expect(a).toHaveLength(32);
    expect(statSync(join(dir, "secrets.key")).mode & 0o777).toBe(0o600);
    expect(loadOrCreateSecretsKey(dir).equals(a)).toBe(true);
  });
});

describe("RepoEnv", () => {
  const setup = () => {
    const dir = tmp();
    const { db } = openDatabase({ path: join(dir, "g.db") });
    migrate(db, join(import.meta.dir, "../../migrations"));
    const repos = new ReposRepo(db);
    const repo = repos.create({ id: "r1", forge: "github", fullName: "acme/web-app", installationId: "1", slug: "web-app" });
    const audited: unknown[] = [];
    const env = new RepoEnv(repos, new SecretBox(randomBytes(32)), { record: (_a, action, target, change) => audited.push({ action, target, ...change }) });
    return { db, repos, repo, env, audited };
  };

  test("set merges (a plain string is `standard`), levels re-level, unset removes; the listing is names+levels; the row holds ciphertext only; the audit holds names only", () => {
    const { repos, repo, env, audited, db } = setup();
    expect(env.list(repo.id)).toEqual([]);
    expect(env.update(null, repo, { set: { FONTAWESOME_TOKEN: { value: "fa-abc", level: "high" }, B: "2", PUBLIC_KEY: { value: "pk", level: "low" } } }))
      .toEqual([{ name: "B", level: "standard" }, { name: "FONTAWESOME_TOKEN", level: "high" }, { name: "PUBLIC_KEY", level: "low" }]);
    // A plain string on an existing name keeps its level.
    expect(env.update(null, repo, { set: { FONTAWESOME_TOKEN: "fa-new" }, levels: { B: "high" } })).toEqual([{ name: "B", level: "high" }, { name: "FONTAWESOME_TOKEN", level: "high" }, { name: "PUBLIC_KEY", level: "low" }]);
    expect(env.valuesFor(repo.id, "high")).toEqual({ B: "2", FONTAWESOME_TOKEN: "fa-new", PUBLIC_KEY: "pk" });
    expect(env.valuesFor(repo.id, "standard")).toEqual({ PUBLIC_KEY: "pk" });
    expect(env.valuesFor(repo.id, "low")).toEqual({ PUBLIC_KEY: "pk" });
    expect(env.valuesFor(repo.id, "none")).toEqual({});
    const row = db.get<{ env_ciphertext: string }>("SELECT env_ciphertext FROM repos WHERE id = 'r1'")!;
    expect(row.env_ciphertext).toMatch(/^v1\./);
    expect(row.env_ciphertext).not.toContain("fa-new");
    expect(JSON.stringify(audited)).not.toMatch(/fa-new|fa-abc/);
    expect(audited.at(-1)).toMatchObject({ action: "repo.env.changed", target: "r1", new: { names: ["B", "FONTAWESOME_TOKEN", "PUBLIC_KEY"], set: ["FONTAWESOME_TOKEN"], levels: { B: "high" } } });
    expect(env.update(null, repo, { unset: ["B", "FONTAWESOME_TOKEN", "PUBLIC_KEY"] })).toEqual([]);
    expect(repos.envCiphertext(repo.id)).toBeNull();
    expect(() => env.update(null, repo, { levels: { NOPE: "low" } })).toThrow(/not set/);
  });

  test("the first shape -- a bare string per name -- reads as `standard`", () => {
    const { repos, repo, env } = setup();
    const box = new SecretBox(randomBytes(32));
    const legacy = new RepoEnv(repos, box);
    repos.setEnvCiphertext(repo.id, box.seal(JSON.stringify({ OLD: "v" })));
    expect(legacy.list(repo.id)).toEqual([{ name: "OLD", level: "standard" }]);
    void env;
  });

  test("a bad name or an oversized value is refused", () => {
    const { repo, env } = setup();
    expect(() => env.update(null, repo, { set: { "1BAD": "x" } })).toThrow(/not a valid environment variable name/);
    expect(() => env.update(null, repo, { set: { "with-dash": "x" } })).toThrow(/not a valid/);
    expect(() => env.update(null, repo, { set: { BIG: "x".repeat(17 * 1024) } })).toThrow(/longer than/);
  });
});

describe("dotenvLine", () => {
  test.each([
    ["A", "plain", 'A="plain"'],
    ["A", 'say "hi"', 'A="say \\"hi\\""'],
    ["A", "two\nlines", 'A="two\\nlines"'],
    ["A", "back\\slash", 'A="back\\\\slash"'],
    ["A", "$HOME", 'A="\\$HOME"'],
  ])("%s=%j -> %s", (k, v, want) => expect(dotenvLine(k, v)).toBe(want));
});

describe("githubFullName", () => {
  test.each([
    ["https://github.com/acme/web-app.git", "acme/web-app"], ["https://github.com/acme/web-app", "acme/web-app"], ["https://github.com/acme/web-app/", "acme/web-app"],
    ["https://GitHub.com/Acme/Web-App.git", "Acme/Web-App"], ["https://gitlab.com/acme/web-app.git", null], ["https://github.com/acme", null], ["not a url", null],
  ])("%s -> %j", (url, want) => expect(githubFullName(url)).toBe(want));
});
