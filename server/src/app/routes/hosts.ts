import type { Hono } from "hono";
import type { Host } from "@gangway/shared/domain";
import type { HostsRepo } from "../../db/repos/hosts.ts";
import { redactString } from "../../logger.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

const toWire = (h: Host) => ({ ...h, dockerHost: redactString(h.dockerHost) });

export function hostRoutes(api: Hono<AppEnv>, hosts: HostsRepo): void {
  api.get("/hosts", requirePermission("hosts.read"), (c) =>
    c.json({ hosts: hosts.list().map(toWire) }),
  );
}
