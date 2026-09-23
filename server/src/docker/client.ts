import Dockerode from "dockerode";
import type { Host } from "@gangway/shared/domain";
import { badRequest } from "../errors.ts";
import { assertHostDaemon, type DockerInfo, type GuardOk } from "./guard.ts";
import type { InspectJson } from "./inspect.ts";

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

function parseDockerHost(dockerHost: string): Dockerode.DockerOptions {
  const s = dockerHost.trim();
  if (s === "") throw badRequest("dockerHost is empty");
  if (s.startsWith("/") || s.startsWith("./")) return { socketPath: s };
  if (s.startsWith("unix://")) return { socketPath: s.slice("unix://".length) };
  if (s.startsWith("npipe://")) return { socketPath: s.slice("npipe://".length) };

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw badRequest(`unparseable dockerHost: ${JSON.stringify(dockerHost)}`);
  }

  const scheme = url.protocol.replace(/:$/, "");
  const host = url.hostname;
  if (host === "") throw badRequest(`dockerHost has no host: ${JSON.stringify(dockerHost)}`);

  if (scheme === "ssh") {
    return {
      protocol: "ssh",
      host,
      port: url.port === "" ? 22 : Number(url.port),
      ...(url.username === "" ? {} : { username: decodeURIComponent(url.username) }),
      sshOptions: { host, ...(url.port === "" ? {} : { port: Number(url.port) }) },
    };
  }
  if (scheme === "tcp" || scheme === "http" || scheme === "https") {
    // https:// is how the operator says TLS; do not guess from DOCKER_TLS_VERIFY.
    return {
      protocol: scheme === "https" ? "https" : "http",
      host,
      port: url.port === "" ? 2375 : Number(url.port),
    };
  }
  throw badRequest(`unsupported dockerHost scheme: ${JSON.stringify(scheme)}`);
}

type NodeReadableLike = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy?: (err?: Error) => void;
};

const asIterable = (s: unknown): AsyncIterable<Uint8Array> => s as AsyncIterable<Uint8Array>;

const DEMUX_HEADER = 8;

// Non-TTY logs carry an 8-byte frame header and TTY logs are raw; sniff rather than inspect.
export async function* demultiplex(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ stream: LogStream; bytes: Uint8Array }> {
  let buf = new Uint8Array(0);
  const append = (next: Uint8Array) => {
    const merged = new Uint8Array(buf.length + next.length);
    merged.set(buf);
    merged.set(next, buf.length);
    buf = merged;
  };

  for await (const chunk of chunks) {
    append(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    for (;;) {
      if (buf.length < DEMUX_HEADER) break;
      const type = buf[0]!;
      const framed =
        (type === 0 || type === 1 || type === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
      if (!framed) {
        yield { stream: "stdout", bytes: buf };
        buf = new Uint8Array(0);
        break;
      }
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const size = view.getUint32(4, false);
      if (buf.length < DEMUX_HEADER + size) break;
      yield {
        stream: type === 2 ? "stderr" : "stdout",
        bytes: buf.slice(DEMUX_HEADER, DEMUX_HEADER + size),
      };
      buf = buf.slice(DEMUX_HEADER + size);
    }
  }
  if (buf.length > 0) yield { stream: "stdout", bytes: buf };
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/s;

export async function* toLogLines(
  frames: AsyncIterable<{ stream: LogStream; bytes: Uint8Array }>,
  timestamps: boolean,
): AsyncGenerator<LogLine> {
  const dec = new TextDecoder();
  const partial: Record<LogStream, string> = { stdout: "", stderr: "" };

  const emit = (stream: LogStream, raw: string): LogLine => {
    if (!timestamps) return { stream, line: raw };
    const m = TS_RE.exec(raw);
    if (!m) return { stream, line: raw };
    const at = new Date(m[1]!);
    return Number.isNaN(at.getTime()) ? { stream, line: raw } : { stream, line: m[2]!, at };
  };

  for await (const frame of frames) {
    const text = partial[frame.stream] + dec.decode(frame.bytes, { stream: true });
    const parts = text.split("\n");
    partial[frame.stream] = parts.pop() ?? "";
    for (const p of parts) yield emit(frame.stream, p.replace(/\r$/, ""));
  }
  for (const stream of ["stdout", "stderr"] as const) {
    const rest = partial[stream];
    if (rest !== "") yield emit(stream, rest);
  }
}

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

type ContainerInfoLike = {
  Id: string;
  Names?: string[] | undefined;
  Image?: string | undefined;
  State?: string | undefined;
  Status?: string | undefined;
  Labels?: Record<string, string> | undefined;
  Created?: number | undefined;
  Ports?:
    Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type?: string }> | undefined;
};

function toSummary(c: ContainerInfoLike): ContainerSummary {
  return {
    id: c.Id,
    names: (c.Names ?? []).map((n) => (n.startsWith("/") ? n.slice(1) : n)),
    image: c.Image ?? "",
    state: c.State ?? "",
    status: c.Status ?? "",
    labels: c.Labels ?? {},
    ports: (c.Ports ?? []).map((p) => ({
      ip: p.IP ?? null,
      containerPort: p.PrivatePort,
      hostPort: p.PublicPort ?? null,
      protocol: p.Type ?? "tcp",
    })),
    createdAt: new Date((c.Created ?? 0) * 1000),
  };
}

export async function* parseEventStream(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<DockerEvent> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of chunks) {
    buf += dec.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const ev = parseEventLine(line);
      if (ev) yield ev;
      nl = buf.indexOf("\n");
    }
  }
  const last = parseEventLine(buf.trim());
  if (last) yield last;
}

function parseEventLine(line: string): DockerEvent | null {
  if (line === "") return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const actor = (raw["Actor"] ?? {}) as { ID?: string; Attributes?: Record<string, string> };
  const nano = typeof raw["timeNano"] === "number" ? raw["timeNano"] : null;
  const secs = typeof raw["time"] === "number" ? raw["time"] : 0;
  return {
    type: typeof raw["Type"] === "string" ? raw["Type"] : "",
    action: typeof raw["Action"] === "string" ? raw["Action"] : "",
    id: typeof raw["id"] === "string" ? raw["id"] : (actor.ID ?? ""),
    actor: { id: actor.ID ?? "", attributes: actor.Attributes ?? {} },
    time: new Date(nano === null ? secs * 1000 : nano / 1e6),
  };
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
