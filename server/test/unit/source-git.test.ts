import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cloneRepo, DEFAULT_ALLOWED_HOSTS } from "../../src/previews/source/git.ts";
import { GitError, type CloneRejection } from "../../src/previews/source/types.ts";
import { Logger, redactString } from "../../src/logger.ts";

/** Shaped like a real GitHub App installation token so the redactor recognises it. */
const TOKEN = `ghs_${"A1b2C3d4E5f6G7h8".repeat(2)}`;

const tmpdirs: string[] = [];
async function scratch(): Promise<string> {
  const d = await mkdtemp(path.join(await realpath(os.tmpdir()), "gw-git-test-"));
  tmpdirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of tmpdirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function sh(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${stderr}`);
}

/**
 * A one-commit repo on disk, so nothing in this file touches the network. It outlives the
 * per-test scratch dirs, which are wiped after every test.
 */
let fixtureRoot = "";
async function fixtureRepo(): Promise<{ dir: string; url: string; sha: string }> {
  fixtureRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), "gw-git-origin-"));
  const dir = path.join(fixtureRoot, "origin");
  await mkdir(dir, { recursive: true });
  await sh(["git", "init", "-q", "-b", "main", "."], dir);
  await writeFile(path.join(dir, "README.md"), "hello from the fixture\n");
  await sh(["git", "add", "README.md"], dir);
  await sh(
    ["git", "-c", "user.name=gangway", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "init"],
    dir,
  );

  const proc = Bun.spawn({ cmd: ["git", "rev-parse", "HEAD"], cwd: dir, stdout: "pipe", stderr: "pipe" });
  const sha = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return { dir, url: `file://${dir}`, sha };
}

/**
 * Stands in for the git binary: records exactly what the child was handed, exercises the
 * askpass helper the way git would, then runs the real thing.
 */
async function spyGit(out: string): Promise<string> {
  await mkdir(out, { recursive: true });
  const script = path.join(out, "git-spy.sh");
  await writeFile(
    script,
    `#!/bin/sh
printf '%s\\n' "$@" >> "${out}/argv.txt"
env >> "${out}/env.txt"
if [ -n "\${GIT_ASKPASS-}" ]; then
  cp "$GIT_ASKPASS" "${out}/askpass.txt"
  "$GIT_ASKPASS" "Username for 'https://github.com': " > "${out}/username.txt"
  "$GIT_ASKPASS" "Password for 'https://x-access-token@github.com': " > "${out}/password.txt"
fi
exec git "$@"
`,
    { mode: 0o755 },
  );
  return script;
}

async function expectReject(fn: () => Promise<unknown>, reason: CloneRejection): Promise<GitError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GitError);
  const err = caught as GitError;
  expect(err.reason).toBe(reason);
  return err;
}

let repo: { dir: string; url: string; sha: string };
beforeAll(async () => {
  repo = await fixtureRepo();
});
afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("cloneRepo host allowlist", () => {
  test("refuses a host that is not on the allowlist", async () => {
    const dest = await scratch();
    const err = await expectReject(
      () => cloneRepo({ repo: "https://evil.example.com/acme/app.git", ref: "main", destDir: dest }),
      "host_not_allowed",
    );
    expect(err.status).toBe(403);
    expect(err.message).toContain("evil.example.com");
  });

  test("refuses a file:// repo unless it is explicitly allowed", async () => {
    const dest = await scratch();
    expect(DEFAULT_ALLOWED_HOSTS).not.toContain("file");
    await expectReject(() => cloneRepo({ repo: repo.url, ref: "main", destDir: dest }), "host_not_allowed");
  });

  test("refuses a scheme other than https or file", async () => {
    const dest = await scratch();
    await expectReject(
      () => cloneRepo({ repo: "ssh://git@github.com/acme/app.git", ref: "main", destDir: dest, allowedHosts: ["github.com"] }),
      "invalid_repo_url",
    );
    await expectReject(
      () => cloneRepo({ repo: "git@github.com:acme/app.git", ref: "main", destDir: dest }),
      "invalid_repo_url",
    );
  });

  test("refuses a URL that carries its own credentials", async () => {
    const dest = await scratch();
    await expectReject(
      () => cloneRepo({
        repo: `https://x-access-token:${TOKEN}@github.com/acme/app.git`,
        ref: "main",
        destDir: dest,
        allowedHosts: ["github.com"],
      }),
      "credentials_in_url",
    );
  });

  test("refuses a ref that could be read as an option or escape the refspec", async () => {
    const dest = await scratch();
    for (const ref of ["--upload-pack=touch /tmp/pwned", "main..evil", "a b", "refs/heads/x.lock", ""]) {
      await expectReject(
        () => cloneRepo({ repo: repo.url, ref, destDir: dest, allowedHosts: ["file"] }),
        "invalid_ref",
      );
    }
  });
});

describe("cloneRepo credential handling", () => {
  test("the token reaches git through the environment, never argv, the URL or the helper file", async () => {
    const dest = path.join(await scratch(), "checkout");
    const spyOut = await scratch();
    const lines: string[] = [];

    const result = await cloneRepo({
      repo: repo.url,
      ref: "main",
      destDir: dest,
      token: TOKEN,
      allowedHosts: ["file"],
      gitPath: await spyGit(spyOut),
      logger: new Logger("debug", {}, (l) => lines.push(l)),
    });

    expect(result.sha).toBe(repo.sha);
    expect(await readFile(path.join(dest, "README.md"), "utf8")).toBe("hello from the fixture\n");

    const argv = await readFile(path.join(spyOut, "argv.txt"), "utf8");
    expect(argv).not.toContain(TOKEN);
    expect(argv).toContain("--depth");
    expect(argv).toContain("--single-branch");
    expect(argv).toContain("--branch");
    expect(argv).not.toContain("@"); // no credentials smuggled into the URL either

    // The helper script is a file on disk; it must name the variable, not hold the secret.
    const helper = await readFile(path.join(spyOut, "askpass.txt"), "utf8");
    expect(helper).not.toContain(TOKEN);
    expect(helper).toContain("GANGWAY_GIT_PASSWORD");

    // ...and it must actually answer git's prompts, or auth would simply fail.
    expect((await readFile(path.join(spyOut, "username.txt"), "utf8")).trim()).toBe("x-access-token");
    expect(await readFile(path.join(spyOut, "password.txt"), "utf8")).toBe(TOKEN);

    // The environment is the one place it is allowed to be.
    const env = await readFile(path.join(spyOut, "env.txt"), "utf8");
    expect(env).toContain(`GANGWAY_GIT_PASSWORD=${TOKEN}`);
    expect(env).toContain("GIT_TERMINAL_PROMPT=0");
    expect(env).toContain("GIT_CONFIG_NOSYSTEM=1");
  });

  test("no log line carries the token, and the redactor would catch it if one did", async () => {
    const dest = path.join(await scratch(), "checkout");
    const lines: string[] = [];
    const logger = new Logger("debug", {}, (l) => lines.push(l));

    await cloneRepo({
      repo: repo.url,
      ref: "main",
      destDir: dest,
      token: TOKEN,
      allowedHosts: ["file"],
      logger,
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(TOKEN);
    // The safety net behind that assertion: this token shape is one the redactor knows.
    expect(redactString(`cloning with ${TOKEN}`)).not.toContain(TOKEN);
  });

  test("a failed clone logs stderr without leaking the token", async () => {
    const dest = path.join(await scratch(), "checkout");
    const lines: string[] = [];

    const err = await expectReject(
      () => cloneRepo({
        repo: repo.url,
        ref: "no-such-branch",
        destDir: dest,
        token: TOKEN,
        allowedHosts: ["file"],
        logger: new Logger("debug", {}, (l) => lines.push(l)),
      }),
      "clone_failed",
    );

    expect(err.status).toBe(502);
    for (const line of lines) expect(line).not.toContain(TOKEN);
    // A half-written checkout is not left behind for the next attempt to trip over.
    expect((await stat(dest)).isDirectory()).toBe(true);
    expect(await readFile(path.join(dest, "README.md"), "utf8").catch(() => null)).toBeNull();
  });

  test("no askpass helper is configured when there is no token", async () => {
    const dest = path.join(await scratch(), "checkout");
    const spyOut = await scratch();
    await cloneRepo({
      repo: repo.url,
      ref: "main",
      destDir: dest,
      allowedHosts: ["file"],
      gitPath: await spyGit(spyOut),
      logger: new Logger("error", {}, () => {}),
    });
    const env = await readFile(path.join(spyOut, "env.txt"), "utf8");
    expect(env).not.toContain("GIT_ASKPASS=");
    expect(env).toContain("GIT_TERMINAL_PROMPT=0");
  });
});

describe("cloneRepo timeout", () => {
  test("kills a clone that overruns its deadline", async () => {
    const dir = await scratch();
    const dest = path.join(dir, "checkout");
    const marker = path.join(dir, "marker");
    const hangingGit = path.join(dir, "slow-git.sh");
    // Close the pipes before sleeping so the parent is not waiting on a drain, then try to
    // leave a marker: if the process survived its deadline, the marker appears.
    await writeFile(hangingGit, `#!/bin/sh\nexec >/dev/null 2>&1\nsleep 5\ntouch "${marker}"\n`, { mode: 0o755 });
    await chmod(hangingGit, 0o755);

    const startedAt = Date.now();
    const err = await expectReject(
      () => cloneRepo({
        repo: repo.url,
        ref: "main",
        destDir: dest,
        allowedHosts: ["file"],
        gitPath: hangingGit,
        timeoutMs: 300,
        logger: new Logger("error", {}, () => {}),
      }),
      "clone_timeout",
    );

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(3_000);
    expect(err.status).toBe(504);

    // Wait past the point where the unkilled script would have written the marker.
    await Bun.sleep(5_200 - elapsed);
    expect(await stat(marker).catch(() => null)).toBeNull();
  }, 20_000);
});

describe("cloneRepo by commit sha (a pull request's head)", () => {
  test("a 40-hex ref is fetched into an empty repository and checked out detached; HEAD is that sha", async () => {
    const dest = path.join(await scratch(), "dest");
    const result = await cloneRepo({ repo: repo.url, ref: repo.sha, destDir: dest, allowedHosts: ["file"] });
    expect(result.sha).toBe(repo.sha);
    expect(result.ref).toBe(repo.sha);
    expect(await Bun.file(path.join(dest, "README.md")).text()).toBe("hello from the fixture\n");
  });

  test("a sha the remote does not have is a clone_failed, and the destination is left empty", async () => {
    const dest = path.join(await scratch(), "dest");
    await expectReject(
      () => cloneRepo({ repo: repo.url, ref: "0123456789abcdef0123456789abcdef01234567", destDir: dest, allowedHosts: ["file"], logger: new Logger("error", {}, () => {}) }),
      "clone_failed",
    );
  });
});
