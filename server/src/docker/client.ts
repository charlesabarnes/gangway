/**
 * The Docker port: a deliberately narrow surface over dockerode, one instance per host.
 *
 * NARROW IS THE POINT. dockerode is the expedient choice today, not a commitment: the
 * spike found that Bun's `fetch(url, { unix })` speaks the engine API directly and is a
 * viable replacement. That option only survives if dockerode's types never escape this
 * file — so everything crossing the `DockerClient` boundary is a plain structural type
 * or plain inspect JSON (see inspect.ts), and nothing above here imports dockerode.
 *
 * §3.2: additional hosts are just connection strings. There is no agent and no control
 * channel, so `dockerHost` from the host record is the whole configuration.
 */
import Dockerode from "dockerode";
import type { Host } from "../../../shared/src/domain.ts";
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
  /** Leading slashes stripped. First entry is the one people recognise. */
  names: string[];
  image: string;
  /** `running`, `exited`, `created`, … */
  state: string;
  status: string;
  labels: Record<string, string>;
  ports: ContainerPort[];
  createdAt: Date;
};

/** Daemon-side filters, as the engine API wants them: key -> allowed values. */
export type DockerFilters = Record<string, string[]>;

export type ListOptions = {
  all?: boolean | undefined;
  filters?: DockerFilters | undefined;
};

export type LogStream = "stdout" | "stderr";

export type LogLine = {
  stream: LogStream;
  line: string;
  /** Present only when `timestamps` was requested and the daemon emitted one. */
  at?: Date;
};

export type LogOptions = {
  follow?: boolean | undefined;
  /** Number of trailing lines, or "all". */
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

/**
 * The entire Docker surface the rest of gangway is allowed to see.
 * Lifecycle (`up`, `down`, `build`) is NOT here: §7.1 says shell out to the compose
 * binary for that, and compose.ts does.
 */
export type DockerClient = {
  readonly hostId: string;
  ping(): Promise<void>;
  info(): Promise<DockerInfo>;
  listContainers(opts?: ListOptions): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<InspectJson>;
  /**
   * The ONE mutating call on this surface, and it exists for §11's orphan row only.
   * Stops, never removes: a stopped container releases its port -- the whole argument
   * for touching it -- and is still there to be looked at afterwards.
   */
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  containerLogs(id: string, opts?: LogOptions): AsyncIterable<LogLine>;
  events(opts?: EventOptions): AsyncIterable<DockerEvent>;
  close(): void;
};

/* ------------------------------------------------------------------ connection */

/**
 * `DOCKER_HOST` grammar, as dockerode wants it. A bare path is accepted because
 * `/var/run/docker.sock` is what people actually type.
 */
export function parseDockerHost(dockerHost: string): Dockerode.DockerOptions {
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
    // `tcp://` is plain HTTP unless the operator terminates TLS; spelling it `https://`
    // is how they say so. Guessing from DOCKER_TLS_VERIFY here would reintroduce exactly
    // the ambient-environment coupling guard.ts and compose.ts exist to remove.
    return {
      protocol: scheme === "https" ? "https" : "http",
      host,
      port: url.port === "" ? 2375 : Number(url.port),
    };
  }
  throw badRequest(`unsupported dockerHost scheme: ${JSON.stringify(scheme)}`);
}

/* ------------------------------------------------------------------ stream plumbing */

type NodeReadableLike = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy?: (err?: Error) => void;
};

const asIterable = (s: unknown): AsyncIterable<Uint8Array> =>
  s as unknown as AsyncIterable<Uint8Array>;

const DEMUX_HEADER = 8;

/**
 * Docker frames non-TTY logs as `[stream(1) 0 0 0 size(4, BE)]` + payload; with a TTY
 * the bytes are raw. We sniff rather than ask, because asking costs an inspect call per
 * log stream and gets it wrong anyway the moment the container is recreated with a
 * different TTY setting.
 */
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
      const framed = (type === 0 || type === 1 || type === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
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

/** Splits demultiplexed bytes into lines, holding a partial trailing line back. */
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
    return Number.isNaN(at.getTime())
      ? { stream, line: raw }
      : { stream, line: m[2]!, at };
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

/* ------------------------------------------------------------------ implementation */

export type DockerClientOptions = {
  /** Socket/connect timeout in ms. */
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
    // The engine wants filters as a JSON string; dockerode will accept an object and
    // stringify it, but the string form is stable across dockerode majors.
    if (opts.filters) query["filters"] = JSON.stringify(opts.filters);
    const raw = await this.#docker.listContainers(query);
    return raw.map(toSummary);
  }

  async inspectContainer(id: string): Promise<InspectJson> {
    return (await this.#docker.getContainer(id).inspect()) as InspectJson;
  }

  async stopContainer(id: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.#docker.getContainer(id).stop({ t: timeoutSeconds });
    } catch (e) {
      // 304: already stopped. That is the outcome we wanted.
      if ((e as { statusCode?: number }).statusCode === 304) return;
      throw e;
    }
  }

  containerLogs(id: string, opts: LogOptions = {}): AsyncIterable<LogLine> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const stream = (await self.#docker.getContainer(id).logs({
          stdout: true,
          stderr: true,
          follow: opts.follow ?? false,
          timestamps: opts.timestamps ?? false,
          ...(opts.tail === undefined ? {} : { tail: opts.tail }),
          ...(opts.since === undefined ? {} : { since: Math.floor(opts.since.getTime() / 1000) }),
        } as never)) as unknown as NodeReadableLike;
        yield* self.#consume(stream, opts.signal, (chunks) =>
          toLogLines(demultiplex(chunks), opts.timestamps ?? false));
      },
    };
  }

  events(opts: EventOptions = {}): AsyncIterable<DockerEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const stream = (await self.#docker.getEvents({
          ...(opts.since === undefined ? {} : { since: Math.floor(opts.since.getTime() / 1000) }),
          ...(opts.filters === undefined ? {} : { filters: JSON.stringify(opts.filters) }),
        } as never)) as unknown as NodeReadableLike;
        yield* self.#consume(stream, opts.signal, parseEventStream);
      },
    };
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

  /** Drops every follow stream. dockerode has no connection to close beyond these. */
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
  Ports?: Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type?: string }> | undefined;
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

/** The events endpoint is newline-delimited JSON, one object per event. */
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

export function parseEventLine(line: string): DockerEvent | null {
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

/* ------------------------------------------------------------------ construction */

export type HostConnection = Pick<Host, "id" | "dockerHost" | "expectName">;

export function createDockerClient(
  host: Pick<Host, "id" | "dockerHost">,
  opts: DockerClientOptions = {},
): DockerClient {
  return new DockerodeClient(host.id, host.dockerHost, opts);
}

/**
 * One client per host, rebuilt when the connection string changes. Hosts are edited at
 * runtime (§9), and a cached client still pointed at the old `dockerHost` would keep
 * working against the previous daemon without ever erroring.
 */
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

/**
 * `docker info` + the guard, in the order every caller needs them. Nothing should reach
 * for a client and start creating things without having been through here first.
 */
export async function verifyDaemon(
  client: Pick<DockerClient, "info">,
  host: HostConnection,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ info: DockerInfo; guard: GuardOk }> {
  const info = await client.info();
  return { info, guard: assertHostDaemon(host, info, env) };
}
