import type { Route } from "../../../../shared/src/domain.ts";
import type { Db } from "../types.ts";
import { num, rowToRoute, type RouteRow } from "./mappers.ts";

export type CreateRoute = {
  hostname: string;
  previewId: string;
  service: string;
  containerPort: number;
  upstream: { host: string; port: number };
  primary?: boolean;
};

export class RoutesRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  all(): Route[] {
    return this.#db.query<RouteRow>("SELECT * FROM routes").map(rowToRoute);
  }

  get(hostname: string): Route | undefined {
    const r = this.#db.get<RouteRow>("SELECT * FROM routes WHERE hostname = $h", { h: hostname });
    return r ? rowToRoute(r) : undefined;
  }

  forPreview(previewId: string): Route[] {
    return this.#db.query<RouteRow>(
      "SELECT * FROM routes WHERE preview_id = $p ORDER BY is_primary DESC, service",
      { p: previewId },
    ).map(rowToRoute);
  }

  /** Throws on a hostname or (host, port) collision -- both are constraint violations. */
  create(r: CreateRoute): Route {
    this.#db.run(
      `INSERT INTO routes (hostname, preview_id, service, container_port,
                           upstream_host, upstream_port, is_primary, created_at)
       VALUES ($hostname, $preview_id, $service, $container_port,
               $upstream_host, $upstream_port, $is_primary, $now)`,
      {
        hostname: r.hostname, preview_id: r.previewId, service: r.service,
        container_port: r.containerPort, upstream_host: r.upstream.host,
        upstream_port: r.upstream.port, is_primary: num(r.primary ?? false), now: this.#now(),
      },
    );
    return this.get(r.hostname)!;
  }

  /** The reconciler's UpdateUpstream action: a container came back on a different port. */
  updateUpstream(hostname: string, upstream: { host: string; port: number }): void {
    this.#db.run(
      "UPDATE routes SET upstream_host = $h, upstream_port = $p WHERE hostname = $hostname",
      { hostname, h: upstream.host, p: upstream.port },
    );
  }

  deleteForPreview(previewId: string): number {
    return this.#db.run("DELETE FROM routes WHERE preview_id = $p", { p: previewId }).changes;
  }

  delete(hostname: string): boolean {
    return this.#db.run("DELETE FROM routes WHERE hostname = $h", { h: hostname }).changes > 0;
  }

  /**
   * Ports in use on a host. The routes table IS the port allocation record (ADR-0004),
   * so there is no separate allocator state to drift or leak.
   */
  usedPorts(upstreamHost: string): Set<number> {
    const rows = this.#db.query<{ upstream_port: number }>(
      "SELECT upstream_port FROM routes WHERE upstream_host = $h", { h: upstreamHost },
    );
    return new Set(rows.map((r) => r.upstream_port));
  }
}
