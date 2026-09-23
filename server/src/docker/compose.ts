/**
 * `docker compose`, split into the half that has bugs and the half that has I/O.
 *
 * gangway shells out to the compose binary rather than reimplementing the Compose spec, so
 * this module is an argv builder and a stream reader. The argv builder is where things go
 * wrong (a global flag after the subcommand, a project name compose normalises, an inherited
 * variable that redirects the invocation), so `composeArgv` and `composeEnv` are pure and
 * tested with no daemon; only `runCompose` touches a process.
 *
 * `DOCKER_CONTEXT` beats `DOCKER_HOST` in the CLI's precedence order, so an active local
 * context would silently win. Every child gets `DOCKER_CONTEXT: ""` explicitly (an empty
 * value is what disables it, not deleting it) alongside the host's `DOCKER_HOST`.
 */
import { badRequest } from "../errors.ts";

export const DEFAULT_DOCKER_BIN = "docker";

/** Compose's own project-name rule. Anything else it would mangle or reject. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export type ComposeSpec = {
  /** `-p` — namespaces containers, network and volumes; `down -v` removes all of it. */
  project: string;
  /** `-f`, in order. Compose merges later files over earlier ones, so order matters. */
  files: string[];
  /** The subcommand: `up`, `down`, `build`, `ps`, `run`, … */
  command: string;
  /** Flags and positionals that follow the subcommand. */
  args?: string[] | undefined;
  /** `--project-directory`. Without it compose resolves relative paths against file #1. */
  projectDirectory?: string | undefined;
  envFiles?: string[] | undefined;
  profiles?: string[] | undefined;
  /** Overridable for tests and for wrapper binaries. */
  docker?: string | undefined;
};

/**
 * Commands that address a project purely by `-p`, through the labels compose put on what
 * it created. Teardown must be one of them: after a crash the workdir may be gone, and a
 * compose file that no longer parses must never be able to block `down`.
 */
const FILELESS_COMMANDS: ReadonlySet<string> = new Set(["down", "ps", "logs", "stop", "start"]);

const assertFlagSafe = (value: string, what: string): string => {
  if (value === "") throw badRequest(`${what} is empty`);
  if (value.startsWith("-")) {
    // A path or name beginning with "-" is consumed as a flag by every CLI ever written.
    throw badRequest(`${what} must not start with "-": ${JSON.stringify(value)}`);
  }
  return value;
};

/**
 * The full argv, binary included, ready for `Bun.spawn`.
 *
 * Global flags come before the subcommand. This is not stylistic: `docker compose up -p
 * foo` is a parse error and `docker compose up -f x.yaml` means something else entirely.
 */
export function composeArgv(spec: ComposeSpec): string[] {
  if (!PROJECT_NAME_RE.test(spec.project)) {
    throw badRequest(
      `invalid compose project name ${JSON.stringify(spec.project)} — must match ${PROJECT_NAME_RE.source}`,
    );
  }
  if (spec.files.length === 0 && !FILELESS_COMMANDS.has(spec.command)) {
    throw badRequest(`compose ${spec.command} needs at least one compose file`);
  }

  const argv: string[] = [spec.docker ?? DEFAULT_DOCKER_BIN, "compose"];

  argv.push("--project-name", spec.project);
  if (spec.projectDirectory !== undefined) {
    argv.push("--project-directory", assertFlagSafe(spec.projectDirectory, "projectDirectory"));
  }
  for (const f of spec.files) argv.push("--file", assertFlagSafe(f, "compose file"));
  for (const e of spec.envFiles ?? []) argv.push("--env-file", assertFlagSafe(e, "env file"));
  for (const p of spec.profiles ?? []) argv.push("--profile", assertFlagSafe(p, "profile"));

  argv.push(assertFlagSafe(spec.command, "compose command"));
  for (const a of spec.args ?? []) argv.push(a);

  return argv;
}

type Base = Omit<ComposeSpec, "command" | "args">;

/** Detached: gangway watches healthchecks itself, not compose's. */
export const upArgv = (base: Base, args: string[] = []): string[] =>
  composeArgv({ ...base, command: "up", args: ["-d", ...args] });

/**
 * Teardown is `down -v --remove-orphans`: a renamed service otherwise leaves a container
 * holding its published port forever. `volumes: false` keeps named volumes, so a failed or
 * rescued rebuild does not take an add-on's database with it; only a destroy removes them.
 *
 * `--rmi local` removes the images compose built for the project and nothing else, so a
 * pulled image the operator's own containers may share stays. `all` is for a preview whose
 * image was pushed for it alone, one tag per commit, where `local` would leave one image per
 * push. Without `--rmi` every build leaves an image on the host forever.
 */
export const downArgv = (
  base: Base,
  args: string[] = [],
  rmi: "local" | "all" = "local",
  o: { volumes?: boolean } = {},
): string[] =>
  composeArgv({
    ...base,
    command: "down",
    args: [...(o.volumes === false ? [] : ["-v"]), "--remove-orphans", "--rmi", rmi, ...args],
  });

/** Build progress is streamed over SSE; `plain` is the only parseable progress mode. */
export const buildArgv = (base: Base, services: string[] = [], args: string[] = []): string[] =>
  composeArgv({ ...base, command: "build", args: ["--progress=plain", ...args, ...services] });

/** Idle sleep acts on the whole project. File-less, like `down`: the containers exist. */
export const stopArgv = (base: Base, args: string[] = []): string[] =>
  composeArgv({ ...base, command: "stop", args });

export const startArgv = (base: Base, args: string[] = []): string[] =>
  composeArgv({ ...base, command: "start", args });

export const psArgv = (base: Base, args: string[] = []): string[] =>
  composeArgv({ ...base, command: "ps", args: ["--format", "json", ...args] });

/** The seed hook. `--rm` so a failed seed does not leave a container behind. */
export const runArgv = (
  base: Base,
  service: string,
  command: string[] = [],
  args: string[] = [],
): string[] =>
  composeArgv({
    ...base,
    command: "run",
    args: ["--rm", ...args, assertFlagSafe(service, "service"), ...command],
  });

/* ------------------------------------------------------------------ environment */

/**
 * Ambient variables that silently redirect or reshape a compose invocation. Each is
 * blanked rather than passed through, because for every one of them we already pass the
 * explicit equivalent on the command line — so inheriting it can only ever disagree with
 * what we asked for.
 */
export const NEUTRALISED_ENV = [
  "DOCKER_CONTEXT",
  "COMPOSE_FILE",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_PROFILES",
  "COMPOSE_ENV_FILES",
] as const;

/**
 * What a compose child may inherit. An allowlist, because compose interpolates `${VAR}`
 * in the compose file from its own environment -- and the compose file is the
 * submitter's. Inherit everything and `environment: { X: "${GANGWAY_ADMIN_TOKEN}" }`
 * hands the admin token (or the Cloudflare token, or anything else the operator
 * exported) to a container the submitter controls. These are what the docker CLI itself
 * needs: to find its plugins and ssh, to read registry auth, to reach a TLS or SSH
 * daemon, to get through a proxy.
 */
export const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export type ComposeEnvInput = {
  dockerHost: string;
  /** Extra variables for interpolation inside the compose file. */
  extra?: Record<string, string> | undefined;
};

/** The environment for every compose child. Never inherits a Docker target. */
export function composeEnv(
  input: ComposeEnvInput,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERITED_ENV) {
    const v = base[k];
    if (v !== undefined) env[k] = v;
  }
  for (const k of NEUTRALISED_ENV) env[k] = "";
  Object.assign(env, input.extra ?? {});
  // Last, and after `extra`: nothing gets to redirect which daemon we talk to.
  env["DOCKER_HOST"] = input.dockerHost;
  env["DOCKER_CONTEXT"] = "";
  return env;
}

/* ------------------------------------------------------------------ execution */

export type ComposeEvent =
  | { type: "line"; stream: "stdout" | "stderr"; line: string }
  | { type: "exit"; code: number; signal: string | null };

export type ComposeRunOptions = {
  dockerHost: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Runs before the process is spawned; throw to abort. This is where the daemon guard
   * belongs — `docker compose` will happily talk to whatever daemon it finds, and by the
   * time output arrives the containers exist.
   */
  preflight?: (() => Promise<void>) | undefined;
  baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
};

type Spawned = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
  signalCode: string | null;
};

export type Spawner = (
  argv: string[],
  opts: { cwd?: string; env: Record<string, string> },
) => Spawned;

const bunSpawner: Spawner = (argv, opts) => {
  const proc = Bun.spawn({
    cmd: argv,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
    get signalCode() {
      return proc.signalCode;
    },
  };
};

async function* streamLines(
  stream: ReadableStream<Uint8Array> | null,
  tag: "stdout" | "stderr",
): AsyncGenerator<ComposeEvent> {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        yield { type: "line", stream: tag, line: buf.slice(0, nl).replace(/\r$/, "") };
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buf !== "") yield { type: "line", stream: tag, line: buf };
}

/**
 * Interleaves several async iterators as their values arrive.
 *
 * Draining stdout to completion and then stderr would be simpler and wrong: a build that
 * takes four minutes would deliver its SSE stream in one burst at the end, and BuildKit
 * writes progress to stderr while compose writes to stdout, so the two must flow
 * together or the log reads out of order.
 */
async function* merge<T>(sources: AsyncIterator<T>[]): AsyncGenerator<T> {
  type Settled = { index: number; result: IteratorResult<T> };
  const pending = new Map<number, Promise<Settled>>();
  sources.forEach((it, index) => {
    pending.set(
      index,
      it.next().then((result) => ({ index, result })),
    );
  });
  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(index);
      continue;
    }
    yield result.value;
    const it = sources[index]!;
    pending.set(
      index,
      it.next().then((r) => ({ index, result: r })),
    );
  }
}

/**
 * Runs a compose command, yielding output lines as they arrive and an `exit` event last.
 * Nothing is buffered to completion: build progress streams over SSE, and a progress bar
 * that appears after the build finishes is not progress.
 */
export async function* runCompose(
  argv: string[],
  opts: ComposeRunOptions,
  spawner: Spawner = bunSpawner,
): AsyncGenerator<ComposeEvent> {
  await opts.preflight?.();
  opts.signal?.throwIfAborted();

  const env = opts.env ?? composeEnv({ dockerHost: opts.dockerHost }, opts.baseEnv ?? process.env);
  const proc = spawner(argv, { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), env });

  const abort = () => proc.kill();
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    yield* merge([
      streamLines(proc.stdout, "stdout")[Symbol.asyncIterator](),
      streamLines(proc.stderr, "stderr")[Symbol.asyncIterator](),
    ]);
    const code = await proc.exited;
    yield { type: "exit", code, signal: proc.signalCode };
  } finally {
    opts.signal?.removeEventListener("abort", abort);
  }
}

export type ComposeResult = { code: number; stdout: string; stderr: string; signal: string | null };

/**
 * Buffering form, for commands whose output is a value rather than a log — `ps --format
 * json` and friends. Streaming those would be pointless; streaming `up` is the point.
 */
export async function composeCapture(
  argv: string[],
  opts: ComposeRunOptions,
  spawner: Spawner = bunSpawner,
): Promise<ComposeResult> {
  const out: string[] = [];
  const err: string[] = [];
  let code = -1;
  let signal: string | null = null;
  for await (const ev of runCompose(argv, opts, spawner)) {
    if (ev.type === "line") (ev.stream === "stdout" ? out : err).push(ev.line);
    else {
      code = ev.code;
      signal = ev.signal;
    }
  }
  return { code, stdout: out.join("\n"), stderr: err.join("\n"), signal };
}

export type ComposePsEntry = {
  name: string;
  service: string;
  state: string;
  health: string | null;
  exitCode: number | null;
  publishers: Array<{ url: string; targetPort: number; publishedPort: number; protocol: string }>;
};

/**
 * Compose changed this output shape mid-v2: older builds print a single JSON array,
 * newer ones print one object per line. Both are in the wild on the same major version,
 * so accept either rather than pinning a compose version we do not control.
 */
export function parseComposePs(stdout: string): ComposePsEntry[] {
  const text = stdout.trim();
  if (text === "") return [];
  const rows: unknown[] = [];
  if (text.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(text);
      if (Array.isArray(arr)) rows.push(...(arr as unknown[]));
    } catch {
      /* fall through to NDJSON */
    }
  }
  if (rows.length === 0) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t === "" || !t.startsWith("{")) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        /* a stray log line, not a row */
      }
    }
  }
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => {
      const pubs = Array.isArray(r["Publishers"])
        ? (r["Publishers"] as Record<string, unknown>[])
        : [];
      return {
        name: typeof r["Name"] === "string" ? r["Name"] : "",
        service: typeof r["Service"] === "string" ? r["Service"] : "",
        state: typeof r["State"] === "string" ? r["State"] : "",
        health: typeof r["Health"] === "string" && r["Health"] !== "" ? r["Health"] : null,
        exitCode: typeof r["ExitCode"] === "number" ? r["ExitCode"] : null,
        publishers: pubs.map((p) => ({
          url: typeof p["URL"] === "string" ? p["URL"] : "",
          targetPort: typeof p["TargetPort"] === "number" ? p["TargetPort"] : 0,
          publishedPort: typeof p["PublishedPort"] === "number" ? p["PublishedPort"] : 0,
          protocol: typeof p["Protocol"] === "string" ? p["Protocol"] : "tcp",
        })),
      };
    });
}
