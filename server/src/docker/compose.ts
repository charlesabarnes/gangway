import { badRequest } from "../errors.ts";

const DEFAULT_DOCKER_BIN = "docker";

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export type ComposeSpec = {
  project: string;
  files: string[];
  command: string;
  args?: string[] | undefined;
  projectDirectory?: string | undefined;
  envFiles?: string[] | undefined;
  profiles?: string[] | undefined;
  docker?: string | undefined;
};

// Addressed by -p alone, so a missing or broken compose file can never block down.
const FILELESS_COMMANDS: ReadonlySet<string> = new Set(["down", "ps", "logs", "stop", "start"]);

const assertFlagSafe = (value: string, what: string): string => {
  if (value === "") throw badRequest(`${what} is empty`);
  if (value.startsWith("-")) {
    throw badRequest(`${what} must not start with "-": ${JSON.stringify(value)}`);
  }
  return value;
};

// Global flags must come before the subcommand.
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

export const upArgv = (base: Base, args: string[] = []): string[] =>
  composeArgv({ ...base, command: "up", args: ["-d", ...args] });

// --remove-orphans, or a renamed service's container holds its port forever.
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

export const buildArgv = (base: Base, services: string[] = [], args: string[] = []): string[] =>
  composeArgv({ ...base, command: "build", args: ["--progress=plain", ...args, ...services] });

export const stopArgv = (base: Base, args: string[] = []): string[] =>
  composeArgv({ ...base, command: "stop", args });

export const startArgv = (base: Base, args: string[] = []): string[] =>
  composeArgv({ ...base, command: "start", args });

export const psArgv = (base: Base, args: string[] = []): string[] =>
  composeArgv({ ...base, command: "ps", args: ["--format", "json", ...args] });

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

export const NEUTRALISED_ENV = [
  "DOCKER_CONTEXT",
  "COMPOSE_FILE",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_PROFILES",
  "COMPOSE_ENV_FILES",
] as const;

// An allowlist: compose interpolates ${VAR} in the submitter's compose file from this environment.
const INHERITED_ENV = [
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
  extra?: Record<string, string> | undefined;
};

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
  // An empty DOCKER_CONTEXT disables an active context, which would otherwise beat DOCKER_HOST.
  env["DOCKER_HOST"] = input.dockerHost;
  env["DOCKER_CONTEXT"] = "";
  return env;
}

export type ComposeEvent =
  | { type: "line"; stream: "stdout" | "stderr"; line: string }
  | { type: "exit"; code: number; signal: string | null };

export type ComposeRunOptions = {
  dockerHost: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
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

// BuildKit writes progress to stderr and compose to stdout, so both must stream together.
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

// Compose v2 prints either a JSON array or NDJSON, depending on the release.
export function parseComposePs(stdout: string): ComposePsEntry[] {
  const text = stdout.trim();
  if (text === "") return [];
  const rows: unknown[] = [];
  if (text.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(text);
      if (Array.isArray(arr)) rows.push(...(arr as unknown[]));
    } catch {
      // fall through to NDJSON
    }
  }
  if (rows.length === 0) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t === "" || !t.startsWith("{")) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        // a stray log line, not a row
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
