import { must } from "@gangway/shared/must";
import type { Route } from "@gangway/shared/domain";
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
    return (this.#db.query("SELECT * FROM routes") as RouteRow[]).map(rowToRoute);
  }

  get(hostname: string): Route | undefined {
    const r = this.#db.get("SELECT * FROM routes WHERE hostname = $h", { h: hostname }) as
      RouteRow | undefined;
    return r ? rowToRoute(r) : undefined;
  }

  forPreview(previewId: string): Route[] {
    return (
      this.#db.query(
        "SELECT * FROM routes WHERE preview_id = $p ORDER BY is_primary DESC, service",
        { p: previewId },
      ) as RouteRow[]
    ).map(rowToRoute);
  }

  create(r: CreateRoute): Route {
    this.#db.run(
      `INSERT INTO routes (hostname, preview_id, service, container_port,
                           upstream_host, upstream_port, is_primary, created_at)
       VALUES ($hostname, $preview_id, $service, $container_port,
               $upstream_host, $upstream_port, $is_primary, $now)`,
      {
        hostname: r.hostname,
        preview_id: r.previewId,
        service: r.service,
        container_port: r.containerPort,
        upstream_host: r.upstream.host,
        upstream_port: r.upstream.port,
        is_primary: num(r.primary ?? false),
        now: this.#now(),
      },
    );
    return must(this.get(r.hostname), "the route just saved");
  }

  updateUpstream(hostname: string, upstream: { host: string; port: number }): void {
    this.#db.run(
      "UPDATE routes SET upstream_host = $h, upstream_port = $p WHERE hostname = $hostname",
      { hostname, h: upstream.host, p: upstream.port },
    );
  }

  /** Moves routes to new hostnames together, or none of them. */
  rename(moves: ReadonlyMap<string, string>): void {
    this.#db.transaction(() => {
      for (const [from, to] of moves) {
        this.#db.run("UPDATE routes SET hostname = $to WHERE hostname = $from", { from, to });
      }
    });
  }

  deleteForPreview(previewId: string): number {
    return this.#db.run("DELETE FROM routes WHERE preview_id = $p", { p: previewId }).changes;
  }

  delete(hostname: string): boolean {
    return this.#db.run("DELETE FROM routes WHERE hostname = $h", { h: hostname }).changes > 0;
  }

  usedPorts(upstreamHost: string): Set<number> {
    const rows = this.#db.query("SELECT upstream_port FROM routes WHERE upstream_host = $h", {
      h: upstreamHost,
    }) as { upstream_port: number }[];
    return new Set(rows.map((r) => r.upstream_port));
  }
}
