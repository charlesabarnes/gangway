import type { DockerInfo } from "./guard.ts";
import type { InspectJson } from "./inspect-json.ts";

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
