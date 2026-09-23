/**
 * The seam between the deploy pipeline and a real `docker compose` process. The pipeline
 * depends on this type, so every branch of it -- including the frightening ones -- runs
 * in unit tests against a fake with no daemon anywhere.
 */
import type { Host } from "@gangway/shared/domain";
import { AppError, errorMessage } from "../errors.ts";
import { verifyDaemon, type DockerClients } from "./client.ts";
import {
  composeCapture,
  composeEnv,
  runCompose,
  type ComposeEvent,
  type ComposeResult,
} from "./compose.ts";
import { DockerGuardError } from "./guard.ts";

export type ComposeTarget = Pick<Host, "id" | "dockerHost" | "expectName">;

export type ComposeRunOpts = {
  cwd: string;
  signal?: AbortSignal | undefined;
  /** Added to the child's allowlisted environment -- a per-deploy DOCKER_CONFIG, say. Never DOCKER_HOST. */
  env?: Record<string, string> | undefined;
};

export type ComposeRunner = {
  stream(argv: string[], host: ComposeTarget, o: ComposeRunOpts): AsyncIterable<ComposeEvent>;
  capture(argv: string[], host: ComposeTarget, o: ComposeRunOpts): Promise<ComposeResult>;
};

export function createComposeRunner(
  clients: DockerClients,
  onHostState?: (hostId: string, ok: boolean, error: string | null) => void,
): ComposeRunner {
  // EVERY invocation is preceded by `docker info` + the guard. It costs one round trip
  // and it is the only thing standing between a dropped tunnel and a preview deployed to
  // whatever daemon the CLI found instead.
  const preflight = (host: ComposeTarget) => async () => {
    try {
      await verifyDaemon(clients.for(host), host);
      onHostState?.(host.id, true, null);
    } catch (e) {
      if (e instanceof DockerGuardError) throw e;
      const message = errorMessage(e);
      onHostState?.(host.id, false, message);
      throw new AppError("unavailable", `host "${host.id}" is unreachable: ${message}`, {
        hostId: host.id,
      });
    }
  };
  const opts = (host: ComposeTarget, o: ComposeRunOpts) => ({
    dockerHost: host.dockerHost,
    cwd: o.cwd,
    signal: o.signal,
    preflight: preflight(host),
    ...(o.env ? { env: composeEnv({ dockerHost: host.dockerHost, extra: o.env }) } : {}),
  });
  return {
    stream: (argv, host, o) => runCompose(argv, opts(host, o)),
    capture: (argv, host, o) => composeCapture(argv, opts(host, o)),
  };
}
