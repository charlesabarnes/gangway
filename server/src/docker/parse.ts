import type Dockerode from "dockerode";
import { badRequest } from "../errors.ts";
import type { ContainerSummary } from "./client-types.ts";

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
    // https:// is how the operator says TLS; do not guess from DOCKER_TLS_VERIFY.
    return {
      protocol: scheme === "https" ? "https" : "http",
      host,
      port: url.port === "" ? 2375 : Number(url.port),
    };
  }
  throw badRequest(`unsupported dockerHost scheme: ${JSON.stringify(scheme)}`);
}

export type ContainerInfoLike = {
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

export function toSummary(c: ContainerInfoLike): ContainerSummary {
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
