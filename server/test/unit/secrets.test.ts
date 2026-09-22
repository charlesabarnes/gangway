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
import { Secrets, dotenvLine } from "../../src/secrets/secrets.ts";
import { MemorySettingsStore } from "../../src/settings.ts";

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

describe("Secrets: two scopes, one shape", () => {
  const setup = () => {
    const dir = tmp();
    const { db } = openDatabase({ path: join(dir, "g.db") });
    migrate(db, join(import.meta.dir, "../../migrations"));
    const repos = new ReposRepo(db);
    const repo = repos.create({ id: "r1", forge: "github", fullName: "acme/web-app", installationId: "1", slug: "web-app" });
    const audited: unknown[] = [];
    const store = new MemorySettingsStore();
    const secrets = new Secrets(repos, store, new SecretBox(randomBytes(32)), { record: (_a, action, target, change) => audited.push({ action, target, ...change }) });
    return { db, repos, repo, secrets, audited, store };
  };

  test("a repository's map: set merges (a plain string is `standard`), levels re-level, unset removes; the row holds ciphertext only; the audit holds names only", () => {
    const { repos, repo, secrets, audited, db } = setup();
    const m = secrets.repo(repo.id);
    expect(m.list()).toEqual([]);
    expect(m.update(null, { set: { FONTAWESOME_TOKEN: { value: "fa-abc", level: "high" }, B: "2", PUBLIC_KEY: { value: "pk", level: "low" } } }))
      .toEqual([{ name: "B", level: "standard" }, { name: "FONTAWESOME_TOKEN", level: "high" }, { name: "PUBLIC_KEY", level: "low" }]);
    expect(m.update(null, { set: { FONTAWESOME_TOKEN: "fa-new" }, levels: { B: "high" } })).toEqual([{ name: "B", level: "high" }, { name: "FONTAWESOME_TOKEN", level: "high" }, { name: "PUBLIC_KEY", level: "low" }]);
    expect(secrets.valuesFor(repo.id, "high")).toEqual({ B: "2", FONTAWESOME_TOKEN: "fa-new", PUBLIC_KEY: "pk" });
    expect(secrets.valuesFor(repo.id, "standard")).toEqual({ PUBLIC_KEY: "pk" });
    expect(secrets.valuesFor(repo.id, "none")).toEqual({});
    const row = db.get<{ env_ciphertext: string }>("SELECT env_ciphertext FROM repos WHERE id = 'r1'")!;
    expect(row.env_ciphertext).toMatch(/^v1\./);
    expect(JSON.stringify([row, audited])).not.toMatch(/fa-new|fa-abc/);
    expect(audited.at(-1)).toMatchObject({ action: "repo.env.changed", target: "r1", new: { names: ["B", "FONTAWESOME_TOKEN", "PUBLIC_KEY"], set: ["FONTAWESOME_TOKEN"], levels: { B: "high" } } });
    expect(m.update(null, { unset: ["B", "FONTAWESOME_TOKEN", "PUBLIC_KEY"] })).toEqual([]);
    expect(repos.envCiphertext(repo.id)).toBeNull();
    expect(() => m.update(null, { levels: { NOPE: "low" } })).toThrow(/not set/);
  });

  test("the global map reaches a preview with no repository too, and a repository's entry wins on a name", () => {
    const { repo, secrets, store, audited } = setup();
    secrets.global().update(null, { set: { SHARED: "global", ONLY_GLOBAL: { value: "g", level: "low" }, TOP: { value: "t", level: "high" } } });
    secrets.repo(repo.id).update(null, { set: { SHARED: "repo" } });
    expect(store.get("secrets.global")).toMatch(/^v1\./);
    expect(audited.at(-2)).toMatchObject({ action: "secrets.changed", target: null });
    expect(secrets.valuesFor(null, "standard")).toEqual({ SHARED: "global", ONLY_GLOBAL: "g" });
    expect(secrets.valuesFor(repo.id, "standard")).toEqual({ SHARED: "repo", ONLY_GLOBAL: "g" });
    expect(secrets.valuesFor(repo.id, "high")).toEqual({ SHARED: "repo", ONLY_GLOBAL: "g", TOP: "t" });
    expect(secrets.valuesFor(repo.id, "low")).toEqual({ ONLY_GLOBAL: "g" });
    expect(secrets.valuesFor(null, "none")).toEqual({});
    expect(secrets.global().update(null, { unset: ["SHARED", "ONLY_GLOBAL", "TOP"] })).toEqual([]);
    expect(secrets.valuesFor(repo.id, "high")).toEqual({ SHARED: "repo" });
  });

  test("the first shape -- a bare string per name -- reads as `standard`", () => {
    const { repos, repo, secrets } = setup();
    const box = new SecretBox(randomBytes(32));
    const legacy = new Secrets(repos, new MemorySettingsStore(), box);
    repos.setEnvCiphertext(repo.id, box.seal(JSON.stringify({ OLD: "v" })));
    expect(legacy.repo(repo.id).list()).toEqual([{ name: "OLD", level: "standard" }]);
    void secrets;
  });

  test("a bad name or an oversized value is refused", () => {
    const { repo, secrets } = setup();
    const m = secrets.repo(repo.id);
    expect(() => m.update(null, { set: { "1BAD": "x" } })).toThrow(/not a valid environment variable name/);
    expect(() => m.update(null, { set: { "with-dash": "x" } })).toThrow(/not a valid/);
    expect(() => m.update(null, { set: { BIG: "x".repeat(17 * 1024) } })).toThrow(/longer than/);
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
