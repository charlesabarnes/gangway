/**
 * Server-side git clone (§5.1, the PR and "deploy a branch" paths).
 *
 * The credential is a GitHub App installation token, and the whole shape of this module is
 * about where that token is allowed to exist. Not in the URL: git copies remote URLs into
 * .git/config, into its own error messages, and into anything that later reads the remote.
 * Not in argv either: on a shared box `ps` is world-readable, and argv ends up in crash
 * dumps and strace output. It goes in the environment, where the kernel restricts it to the
 * process owner, and reaches git through a GIT_ASKPASS helper that prints it on demand.
 * The helper script itself contains no secret, only the name of the variable to echo.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Logger, redactString } from "../../logger.ts";
import { rejectClone } from "./types.ts";

/** Only hosts we mint tokens for. A preview must not be able to point us at an intranet. */
export const DEFAULT_ALLOWED_HOSTS = ["github.com"] as const;

export const DEFAULT_CLONE_TIMEOUT_MS = 120_000;

/** What GitHub expects in the username field when the password is an installation token. */
const TOKEN_USERNAME = "x-access-token";

const ENV_USERNAME = "GANGWAY_GIT_USERNAME";
const ENV_PASSWORD = "GANGWAY_GIT_PASSWORD";

/** Note what is absent: the token. The script only names the variable holding it. */
const ASKPASS = `#!/bin/sh
# Written by gangway. No credential is stored in this file -- it is read from the
# environment, which, unlike argv, is not visible to other users via ps.
case "$1" in
  Username*|username*) printf '%s' "$${ENV_USERNAME}" ;;
  *) printf '%s' "$${ENV_PASSWORD}" ;;
esac
`;

export type CloneOptions = {
  /** An absolute URL. `owner/name` is deliberately not accepted: the host must be explicit. */
  repo: string;
  ref: string;
  destDir: string;
  token?: string | undefined;
  timeoutMs?: number | undefined;
  allowedHosts?: readonly string[] | undefined;
  logger?: Logger | undefined;
  /** Test seam: a stand-in for the git binary. */
  gitPath?: string | undefined;
};

export type CloneResult = {
  dir: string;
  ref: string;
  sha: string;
  durationMs: number;
};

export async function cloneRepo(options: CloneOptions): Promise<CloneResult> {
  const url = parseRepoUrl(options.repo, options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);
  const ref = validateRef(options.ref);
  const gitPath = options.gitPath ?? "git";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const log = (options.logger ?? new Logger()).child({ component: "git", repo: url.href, ref });

  // Doubles as HOME, so git cannot reach the operator's ~/.gitconfig or ~/.git-credentials.
  const helperDir = await mkdtemp(path.join(os.tmpdir(), "gw-git-"));
  const startedAt = Date.now();

  try {
    const env = await buildEnv(helperDir, options.token);

    // A commit sha (a pull request's head) cannot be `--branch`ed; it is fetched into an
    // empty repository instead. GitHub serves any reachable sha to a shallow fetch.
    // `--` keeps a ref or URL that starts with "-" from being read as an option.
    const clone = SHA_RE.test(ref)
      ? await cloneSha(gitPath, url.href, ref, options.destDir, env, timeoutMs)
      : await run(gitPath, [
        "clone", "--depth", "1", "--single-branch", "--branch", ref, "--", url.href, options.destDir,
      ], { env, timeoutMs });

    if (clone.timedOut) {
      await resetDest(options.destDir);
      log.warn("clone timed out", { timeoutMs });
      throw rejectClone("clone_timeout", `git clone exceeded ${timeoutMs}ms`, { timeoutMs });
    }
    if (clone.code !== 0) {
      await resetDest(options.destDir);
      const stderr = tail(clone.stderr);
      log.warn("clone failed", { code: clone.code, stderr });
      throw rejectClone("clone_failed", `git clone failed (exit ${clone.code})`, { stderr });
    }

    const head = await run(gitPath, ["rev-parse", "HEAD"], {
      env,
      timeoutMs,
      cwd: options.destDir,
    });
    if (head.code !== 0) {
      throw rejectClone("clone_failed", "could not read HEAD of the clone", { stderr: tail(head.stderr) });
    }

    const durationMs = Date.now() - startedAt;
    const sha = head.stdout.trim();
    log.info("clone complete", { sha, durationMs });
    return { dir: options.destDir, ref, sha, durationMs };
  } finally {
    await rm(helperDir, { recursive: true, force: true });
  }
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/** `init` + `fetch --depth 1 <sha>` + `checkout FETCH_HEAD`, reported like one `clone`. */
async function cloneSha(
  gitPath: string, href: string, sha: string, destDir: string, env: Record<string, string>, timeoutMs: number,
): Promise<RunResult> {
  const steps: string[][] = [
    ["init", "--quiet", "--", destDir],
    ["-C", destDir, "remote", "add", "origin", "--", href],
    ["-C", destDir, "fetch", "--depth", "1", "--quiet", "origin", sha],
    ["-C", destDir, "checkout", "--quiet", "--detach", "FETCH_HEAD"],
  ];
  let last: RunResult = { code: 0, stdout: "", stderr: "", timedOut: false };
  for (const args of steps) {
    last = await run(gitPath, args, { env, timeoutMs });
    if (last.timedOut || last.code !== 0) return last;
  }
  return last;
}

function parseRepoUrl(repo: string, allowed: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    throw rejectClone("invalid_repo_url", "repository must be an absolute URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "file:") {
    throw rejectClone("invalid_repo_url", `unsupported scheme '${url.protocol.replace(":", "")}'`);
  }
  // A URL carrying its own credentials would defeat the entire point of the askpass helper.
  if (url.username !== "" || url.password !== "") {
    throw rejectClone("credentials_in_url", "repository URL must not embed credentials");
  }

  // file: URLs have no hostname; they are only ever reachable when explicitly allowed.
  const host = url.protocol === "file:" ? "file" : url.hostname.toLowerCase();
  if (!allowed.some((h) => h.toLowerCase() === host)) {
    throw rejectClone("host_not_allowed", `host '${host}' is not in the allowlist`, { host });
  }
  return url;
}

/** git's own rules, plus a leading "-" which would turn the ref into an option. */
function validateRef(ref: string): string {
  const invalid =
    ref.length === 0 ||
    ref.length > 255 ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(ref);
  if (invalid) throw rejectClone("invalid_ref", "ref is not a valid git ref name", { ref: ref.slice(0, 64) });
  return ref;
}

async function buildEnv(helperDir: string, token: string | undefined): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: helperDir,
    // Without this git will happily block forever on a tty prompt that nobody can answer.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    LC_ALL: "C",
  };

  if (token === undefined || token === "") return env;

  const helper = path.join(helperDir, "askpass.sh");
  await writeFile(helper, ASKPASS, { mode: 0o700 });
  env["GIT_ASKPASS"] = helper;
  env[ENV_USERNAME] = TOKEN_USERNAME;
  env[ENV_PASSWORD] = token;
  return env;
}

type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

async function run(
  gitPath: string,
  args: string[],
  o: { env: Record<string, string>; timeoutMs: number; cwd?: string },
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [gitPath, ...args],
    ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
    env: o.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, o.timeoutMs);

  // Drain concurrently with the wait: a child blocked on a full pipe never exits, and a
  // child killed mid-transfer can leave a grandchild holding the write end, so the reads
  // get their own bounded grace period rather than being awaited outright.
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  try {
    const code = await proc.exited;
    return { code, timedOut, stdout: await settle(stdout), stderr: await settle(stderr) };
  } finally {
    clearTimeout(timer);
  }
}

function settle(p: Promise<string>): Promise<string> {
  return Promise.race([
    p.catch(() => ""),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 2_000)),
  ]);
}

/** A half-finished clone is worse than no clone: leave the caller an empty directory. */
async function resetDest(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

const tail = (s: string, n = 2_000) => redactString(s.length > n ? s.slice(-n) : s).trim();
