import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Host } from "@gangway/shared/domain";
import { AppError } from "../errors.ts";
import { composeCapture, composeEnv, type ComposeResult } from "../docker/compose.ts";

export const BUILDER_IMAGE = "moby/buildkit:v0.34.1-rootless";
const BUILDER_PIDS = 2048;
const STEP_TIMEOUT_MS = 120_000;

type Target = Pick<Host, "id" | "dockerHost" | "runtime">;
type Run = (
  argv: string[],
  dockerHost: string,
  env: Record<string, string>,
  signal?: AbortSignal,
) => Promise<ComposeResult>;
type Call = {
  host: Target;
  name: string;
  orgId: string;
  env: Record<string, string>;
  signal?: AbortSignal | undefined;
};

type Spec = { image: string; args: string[]; hash: string };

export type BuilderLease = { args: string[]; env: Record<string, string>; release: () => void };

const run: Run = (argv, dockerHost, env, signal) => {
  const timeout = AbortSignal.timeout(STEP_TIMEOUT_MS);
  return composeCapture(argv, {
    dockerHost,
    env: composeEnv({ dockerHost, extra: env }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
};

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener(
      "abort",
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

/**
 * One rootless BuildKit per org on a sandboxed host, in the host's runtime and on its own network,
 * so one org's build steps and cache never meet another's. It stops when the org's last build ends.
 */
export class Builders {
  readonly #o: {
    instance: string;
    stateDir: string;
    image: () => string;
    memoryBytes: () => number;
    docker: string;
    run: Run;
    onStopFailed: (name: string, e: unknown) => void;
  };
  readonly #held = new Map<string, number>();
  readonly #chain = new Map<string, Promise<unknown>>();
  readonly #up = new Set<string>();

  constructor(o: {
    instance: string;
    stateDir: string;
    image?: () => string;
    memoryBytes?: () => number;
    docker?: string;
    run?: Run;
    onStopFailed?: (name: string, e: unknown) => void;
  }) {
    this.#o = {
      instance: o.instance,
      stateDir: o.stateDir,
      image: o.image ?? (() => BUILDER_IMAGE),
      memoryBytes: o.memoryBytes ?? (() => 0),
      docker: o.docker ?? "docker",
      run: o.run ?? run,
      onStopFailed: o.onStopFailed ?? (() => {}),
    };
  }

  /** Null when the host runs containers in Docker's own runtime: the daemon builds, as before. */
  async acquire(host: Target, orgId: string, signal?: AbortSignal): Promise<BuilderLease | null> {
    if (!host.runtime) {
      return null;
    }
    const name = `gw-${this.#o.instance}-build-${orgId.toLowerCase()}`;
    const key = `${host.id}/${name}`;
    const env = { BUILDX_CONFIG: join(this.#o.stateDir, "buildx", host.id) };
    this.#held.set(key, (this.#held.get(key) ?? 0) + 1);
    try {
      const started = this.#serial(key, async () => {
        signal?.throwIfAborted();
        // A builder in use is never recreated under a running build, even when its spec changed.
        if (!this.#up.has(key)) {
          await this.#start({ host, name, orgId, env, signal });
          this.#up.add(key);
        }
      });
      started.catch(() => {});
      await (signal ? Promise.race([started, aborted(signal)]) : started);
    } catch (e) {
      this.#drop(host, key, name, env);
      throw e;
    }
    let held = true;
    return {
      args: ["--builder", name],
      env,
      release: () => {
        if (held) {
          held = false;
          this.#drop(host, key, name, env);
        }
      },
    };
  }

  #drop(host: Target, key: string, name: string, env: Record<string, string>) {
    const left = (this.#held.get(key) ?? 1) - 1;
    if (left > 0) {
      this.#held.set(key, left);
      return;
    }
    this.#held.delete(key);
    void this.#serial(key, async () => {
      if (!this.#held.has(key)) {
        this.#up.delete(key);
        await this.#docker({ host, name, orgId: "", env }, ["stop", "--time", "5", name]);
      }
    }).catch((e: unknown) => {
      this.#o.onStopFailed(name, e);
    });
  }

  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.#chain.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.#chain.set(key, next);
    void next
      .finally(() => {
        if (this.#chain.get(key) === next) {
          this.#chain.delete(key);
        }
      })
      .catch(() => {});
    return next;
  }

  async #start(c: Call) {
    const spec = this.#spec(c.host);
    const current = await this.#run(c, [
      "inspect",
      "--format",
      '{{index .Config.Labels "gangway.builder.spec"}}',
      c.name,
    ]);
    if (current.code !== 0 || current.stdout.trim() !== spec.hash) {
      await this.#create(c, spec);
    } else {
      await this.#docker(c, ["start", c.name]);
    }
    const known = await this.#run(c, ["buildx", "inspect", c.name]);
    if (known.code !== 0) {
      await this.#docker(c, [
        "buildx",
        "create",
        "--name",
        c.name,
        "--driver",
        "remote",
        `docker-container://${c.name}`,
      ]);
    }
    await this.#docker(c, ["buildx", "inspect", "--bootstrap", c.name]);
  }

  #spec(host: Target): Spec {
    const memory = this.#o.memoryBytes();
    const args = [
      "--runtime",
      host.runtime ?? "runc",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--pids-limit",
      String(BUILDER_PIDS),
      ...(memory > 0 ? ["--memory", String(memory)] : []),
    ];
    const image = this.#o.image();
    const hash = createHash("sha256")
      .update(JSON.stringify([image, args]))
      .digest("hex")
      .slice(0, 16);
    return { image, args, hash };
  }

  async #create(c: Call, spec: Spec) {
    const labels = [
      "--label",
      `gangway.instance=${this.#o.instance}`,
      "--label",
      `gangway.org=${c.orgId}`,
    ];
    await this.#run(c, ["rm", "--force", c.name]);
    const net = await this.#run(c, ["network", "create", ...labels, c.name]);
    if (net.code !== 0 && !net.stderr.includes("already exists")) {
      throw this.#failed(c.host, ["network", "create"], net);
    }
    await this.#docker(c, [
      "run",
      "--detach",
      "--name",
      c.name,
      "--network",
      c.name,
      ...labels,
      "--label",
      `gangway.builder.spec=${spec.hash}`,
      ...spec.args,
      spec.image,
      "--oci-worker-no-process-sandbox",
    ]);
  }

  #run(c: Call, argv: string[]) {
    c.signal?.throwIfAborted();
    return this.#o.run([this.#o.docker, ...argv], c.host.dockerHost, c.env, c.signal);
  }

  async #docker(c: Call, argv: string[]) {
    const r = await this.#run(c, argv);
    if (r.code !== 0) {
      throw this.#failed(c.host, argv.slice(0, 2), r);
    }
  }

  #failed(host: Target, what: string[], r: ComposeResult) {
    return new AppError(
      "unavailable",
      `host "${host.id}": could not start the org's builder (docker ${what.join(" ")} exited ${r.code}): ${r.stderr.trim().slice(-300)}`,
      { hostId: host.id },
    );
  }
}
