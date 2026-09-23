import type { Host } from "@gangway/shared/domain";
import type { RoutesRepo } from "../db/repos/routes.ts";
import type { DockerClient } from "../docker/client-types.ts";
import type { Logger } from "../logger.ts";
import type { PreviewContext } from "../previews/context.ts";
import type { Action } from "./diff.ts";

export type ClientSource = {
  for(
    host: Pick<Host, "id" | "dockerHost">,
  ): Pick<DockerClient, "hostId" | "info" | "listContainers" | "stopContainer">;
};

export type ReconcilerDeps = {
  ctx: PreviewContext;
  routes: RoutesRepo;
  clients: ClientSource;
  logger: Logger;
  orphans?: "stop" | "report";
  env?: Readonly<Record<string, string | undefined>>;
};

export type HostScan = {
  hostId: string;
  reachable: boolean;
  error: string | null;
  containers: number;
};

export type ReconcileReport = {
  at: number;
  hosts: HostScan[];
  actions: Action[];
  changes: string[];
};
