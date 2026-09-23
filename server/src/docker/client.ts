import Dockerode from "dockerode";
import type { Host } from "@gangway/shared/domain";
import { assertHostDaemon, type DockerInfo, type GuardOk } from "./guard.ts";
import type { InspectJson } from "./inspect.ts";
import { parseDockerHost, toSummary } from "./parse.ts";
import { demultiplex, parseEventStream, toLogLines } from "./streams.ts";

export type { DockerInfo } from "./guard.ts";

export type ContainerPort = {
  ip: string | null;
  containerPort: number;
  hostPort: number | null;
  protocol: string;
};

export type ContainerSummary = {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  labels: Record<string, string>;
  ports: ContainerPort[];
  createdAt: Date;
};

export type DockerFilters = Record<string, string[]>;

export type ListOptions = {
  all?: boolean | undefined;
  filters?: DockerFilters | undefined;
};

export type LogStream = "stdout" | "stderr";

export type LogLine = {
  stream: LogStream;
  line: string;
  at?: Date;
};

export type LogOptions = {
  follow?: boolean | undefined;
  tail?: number | "all" | undefined;
  since?: Date | undefined;
  timestamps?: boolean | undefined;
  signal?: AbortSignal | undefined;
};

export type DockerEvent = {
  type: string;
  action: string;
  id: string;
  actor: { id: string; attributes: Record<string, string> };
  time: Date;
};

export type EventOptions = {
  since?: Date | undefined;
  filters?: DockerFilters | undefined;
  signal?: AbortSignal | undefined;
};

export type DockerClient = {
  readonly hostId: string;
  ping(): Promise<void>;
  info(): Promise<DockerInfo>;
  listContainers(opts?: ListOptions): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<InspectJson>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  containerLogs(id: string, opts?: LogOptions): AsyncIterable<LogLine>;
  events(opts?: EventOptions): AsyncIterable<DockerEvent>;
  close(): void;
};

type NodeReadableLike = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy?: (err?: Error) => void;
};

const asIterable = (s: unknown): AsyncIterable<Uint8Array> => s as AsyncIterable<Uint8Array>;

export type DockerClientOptions = {
  timeoutMs?: number | undefined;
};

class DockerodeClient implements DockerClient {
  readonly hostId: string;
  readonly #docker: Dockerode;
  readonly #open = new Set<NodeReadableLike>();

  constructor(hostId: string, dockerHost: string, opts: DockerClientOptions = {}) {
    this.hostId = hostId;
    const base = parseDockerHost(dockerHost);
    this.#docker = new Dockerode(
      opts.timeoutMs === undefined ? base : { ...base, timeout: opts.timeoutMs },
    );
  }

  async ping(): Promise<void> {
    await this.#docker.ping();
  }

  async info(): Promise<DockerInfo> {
    return (await this.#docker.info()) as DockerInfo;
  }

  async listContainers(opts: ListOptions = {}): Promise<ContainerSummary[]> {
    const query: Record<string, unknown> = { all: opts.all ?? false };
    if (opts.filters) query["filters"] = JSON.stringify(opts.filters);
    const raw = await this.#docker.listContainers(query);
    return raw.map(toSummary);
  }

  async inspectContainer(id: string): Promise<InspectJson> {
    return await this.#docker.getContainer(id).inspect();
  }

  async stopContainer(id: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.#docker.getContainer(id).stop({ t: timeoutSeconds });
    } catch (e) {
      // 304 means already stopped.
      if ((e as { statusCode?: number }).statusCode === 304) return;
      throw e;
    }
  }

  containerLogs(id: string, opts: LogOptions = {}): AsyncIterable<LogLine> {
    return { [Symbol.asyncIterator]: () => this.#containerLogs(id, opts) };
  }

  async *#containerLogs(id: string, opts: LogOptions): AsyncGenerator<LogLine> {
    const container = this.#docker.getContainer(id);
    const logs = container.logs.bind(container) as (o: object) => Promise<unknown>;
    const stream = (await logs({
      stdout: true,
      stderr: true,
      follow: opts.follow ?? false,
      timestamps: opts.timestamps ?? false,
      ...(opts.tail === undefined ? {} : { tail: opts.tail }),
      ...(opts.since === undefined ? {} : { since: Math.floor(opts.since.getTime() / 1000) }),
    })) as NodeReadableLike;
    yield* this.#consume(stream, opts.signal, (chunks) =>
      toLogLines(demultiplex(chunks), opts.timestamps ?? false),
    );
  }

  events(opts: EventOptions = {}): AsyncIterable<DockerEvent> {
    return { [Symbol.asyncIterator]: () => this.#events(opts) };
  }

  async *#events(opts: EventOptions): AsyncGenerator<DockerEvent> {
    const stream = (await this.#docker.getEvents({
      ...(opts.since === undefined ? {} : { since: Math.floor(opts.since.getTime() / 1000) }),
      ...(opts.filters === undefined ? {} : { filters: JSON.stringify(opts.filters) }),
    })) as unknown as NodeReadableLike;
    yield* this.#consume(stream, opts.signal, parseEventStream);
  }

  async *#consume<T>(
    stream: NodeReadableLike,
    signal: AbortSignal | undefined,
    transform: (chunks: AsyncIterable<Uint8Array>) => AsyncIterable<T>,
  ): AsyncGenerator<T> {
    this.#open.add(stream);
    const abort = () => stream.destroy?.();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const item of transform(asIterable(stream))) {
        signal?.throwIfAborted();
        yield item;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#open.delete(stream);
      stream.destroy?.();
    }
  }

  close(): void {
    for (const s of this.#open) s.destroy?.();
    this.#open.clear();
  }
}

export type HostConnection = Pick<Host, "id" | "dockerHost" | "expectName">;

function createDockerClient(
  host: Pick<Host, "id" | "dockerHost">,
  opts: DockerClientOptions = {},
): DockerClient {
  return new DockerodeClient(host.id, host.dockerHost, opts);
}

// Rebuilt when dockerHost changes, or a cached client would silently keep using the old daemon.
export class DockerClients {
  readonly #clients = new Map<string, { dockerHost: string; client: DockerClient }>();
  readonly #opts: DockerClientOptions;

  constructor(opts: DockerClientOptions = {}) {
    this.#opts = opts;
  }

  for(host: Pick<Host, "id" | "dockerHost">): DockerClient {
    const existing = this.#clients.get(host.id);
    if (existing && existing.dockerHost === host.dockerHost) return existing.client;
    existing?.client.close();
    const client = createDockerClient(host, this.#opts);
    this.#clients.set(host.id, { dockerHost: host.dockerHost, client });
    return client;
  }

  drop(hostId: string): void {
    this.#clients.get(hostId)?.client.close();
    this.#clients.delete(hostId);
  }

  closeAll(): void {
    for (const { client } of this.#clients.values()) client.close();
    this.#clients.clear();
  }
}

export async function verifyDaemon(
  client: Pick<DockerClient, "info">,
  host: HostConnection,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ info: DockerInfo; guard: GuardOk }> {
  const info = await client.info();
  return { info, guard: assertHostDaemon(host, info, env) };
}
