import type { Host, HostState } from "../../../../shared/src/domain.ts";
import type { Db } from "../types.ts";
import { fromDate, rowToHost, type HostRow } from "./mappers.ts";

export type HostInput = Omit<Host, "createdAt" | "lastSeenAt" | "lastError" | "state"> &
  Partial<Pick<Host, "state" | "lastError" | "lastSeenAt">>;

export class HostsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  list(): Host[] {
    return this.#db.query<HostRow>("SELECT * FROM hosts ORDER BY id").map(rowToHost);
  }

  get(id: string): Host | undefined {
    const r = this.#db.get<HostRow>("SELECT * FROM hosts WHERE id = $id", { id });
    return r ? rowToHost(r) : undefined;
  }

  /** Idempotent: re-seeding the local host from config on every boot must not fail. */
  upsert(h: HostInput): Host {
    this.#db.run(
      `INSERT INTO hosts (id, name, docker_host, expect_name, capabilities, publish_bind,
                          upstream_dial, upstream_address, upstream_proxy,
                          port_range_start, port_range_end, state, created_at)
       VALUES ($id, $name, $docker_host, $expect_name, $capabilities, $publish_bind,
               $upstream_dial, $upstream_address, $upstream_proxy,
               $port_range_start, $port_range_end, $state, $created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         docker_host = excluded.docker_host,
         expect_name = excluded.expect_name,
         capabilities = excluded.capabilities,
         publish_bind = excluded.publish_bind,
         upstream_dial = excluded.upstream_dial,
         upstream_address = excluded.upstream_address,
         upstream_proxy = excluded.upstream_proxy,
         port_range_start = excluded.port_range_start,
         port_range_end = excluded.port_range_end`,
      {
        id: h.id,
        name: h.name,
        docker_host: h.dockerHost,
        expect_name: h.expectName,
        capabilities: JSON.stringify(h.capabilities),
        publish_bind: h.publishBind,
        upstream_dial: h.upstream.dial,
        upstream_address: h.upstream.address,
        upstream_proxy: h.upstream.proxy,
        port_range_start: h.ports.rangeStart,
        port_range_end: h.ports.rangeEnd,
        state: h.state ?? "unknown",
        created_at: this.#now(),
      },
    );
    return this.get(h.id)!;
  }

  /**
   * Reachability is a first-class host property, not an exception. An unreachable host is
   * NOT an empty host: the reconciler must never treat "I could not ask" as "the answer
   * was nothing", or a network blip deletes every route (§11).
   */
  setState(id: string, state: HostState, lastError: string | null = null): void {
    this.#db.run(
      `UPDATE hosts SET state = $state, last_error = $err,
         last_seen_at = CASE WHEN $state = 'ready' THEN $now ELSE last_seen_at END
       WHERE id = $id`,
      { id, state, err: lastError, now: this.#now() },
    );
  }

  withCapability(cap: string): Host[] {
    return this.list().filter((h) => h.capabilities.includes(cap as never));
  }

  delete(id: string): boolean {
    return this.#db.run("DELETE FROM hosts WHERE id = $id", { id }).changes > 0;
  }
}
