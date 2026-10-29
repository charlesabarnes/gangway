import { must } from "@gangway/shared/must";
import type { Host, HostState } from "@gangway/shared/domain";
import type { Db } from "../types.ts";
import { rowToHost, type HostRow } from "./mappers.ts";

export type HostInput = Omit<
  Host,
  | "createdAt"
  | "lastSeenAt"
  | "lastError"
  | "state"
  | "managedBy"
  | "orgId"
  | "capacity"
  | "draining"
> &
  Partial<Pick<Host, "state" | "lastError" | "lastSeenAt" | "managedBy" | "orgId" | "capacity">>;

export class HostsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  list(): Host[] {
    return (
      this.#db.query("SELECT * FROM hosts WHERE removed_at IS NULL ORDER BY id") as HostRow[]
    ).map(rowToHost);
  }

  /** Any host a preview ever named, removed or not. */
  get(id: string): Host | undefined {
    const r = this.#db.get("SELECT * FROM hosts WHERE id = $id", { id }) as HostRow | undefined;
    return r ? rowToHost(r) : undefined;
  }

  named(name: string): Host | undefined {
    const r = this.#db.get("SELECT * FROM hosts WHERE name = $name", { name }) as
      HostRow | undefined;
    return r ? rowToHost(r) : undefined;
  }

  upsert(h: HostInput): Host {
    this.#db.run(
      `INSERT INTO hosts (id, name, docker_host, expect_name, capabilities, publish_bind,
                          upstream_dial, upstream_address, upstream_proxy,
                          port_range_start, port_range_end, managed_by, org_id,
                          memory_bytes, max_previews, state, created_at)
       VALUES ($id, $name, $docker_host, $expect_name, $capabilities, $publish_bind,
               $upstream_dial, $upstream_address, $upstream_proxy,
               $port_range_start, $port_range_end, $managed_by, $org_id,
               $memory_bytes, $max_previews, $state, $created_at)
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
         port_range_end = excluded.port_range_end,
         managed_by = excluded.managed_by,
         org_id = excluded.org_id,
         memory_bytes = excluded.memory_bytes,
         max_previews = excluded.max_previews,
         draining = CASE WHEN hosts.removed_at IS NULL THEN hosts.draining ELSE 0 END,
         removed_at = NULL`,
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
        managed_by: h.managedBy ?? "config",
        org_id: h.orgId ?? null,
        memory_bytes: h.capacity?.memoryBytes ?? null,
        max_previews: h.capacity?.maxPreviews ?? null,
        state: h.state ?? "unknown",
        created_at: this.#now(),
      },
    );
    return must(this.get(h.id), "the host just saved");
  }

  setState(id: string, state: HostState, lastError: string | null = null): void {
    this.#db.run(
      `UPDATE hosts SET state = $state, last_error = $err,
         last_seen_at = CASE WHEN $state = 'ready' THEN $now ELSE last_seen_at END
       WHERE id = $id`,
      { id, state, err: lastError, now: this.#now() },
    );
  }

  setDraining(id: string, draining: boolean): void {
    this.#db.run("UPDATE hosts SET draining = $d WHERE id = $id", { id, d: draining ? 1 : 0 });
  }

  remove(id: string): boolean {
    return (
      this.#db.run(
        "UPDATE hosts SET removed_at = $now, draining = 1 WHERE id = $id AND removed_at IS NULL",
        { id, now: this.#now() },
      ).changes > 0
    );
  }

  withCapability(cap: string): Host[] {
    return this.list().filter((h) => h.capabilities.includes(cap as never));
  }

  delete(id: string): boolean {
    return this.#db.run("DELETE FROM hosts WHERE id = $id", { id }).changes > 0;
  }
}
