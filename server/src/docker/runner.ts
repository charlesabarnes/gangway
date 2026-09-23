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
