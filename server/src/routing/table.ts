/**
 * The in-memory route table: a cache over SQLite, which remains the source of truth (§4).
 *
 * ONE RULE makes the cache safe: every mutation goes through apply(), which writes SQLite
 * first and memory second, inside the same SYNCHRONOUS function. No other code writes the
 * routes table.
 *
 * bun:sqlite being synchronous is what makes that atomic with respect to the event loop --
 * there is no await between the two writes, so no in-flight request can ever observe a
 * half-applied state. A promise-based driver would need a lock here.
 */
import type { PasswordLogin, PreviewState, Route, Visibility } from "@gangway/shared/domain";
import type { RoutesRepo } from "../db/repos/routes.ts";

/**
 * ADR-0023: what the gate needs to know about a preview's password, denormalized like the
 * rest. `inherit` is resolved against the server-wide default per request, so changing the
 * default takes effect at once; `own` carries the preview's scrypt hash.
 */
export type EntryPassword =
  { mode: "inherit" } | { mode: "none" } | { mode: "own"; hash: string; salt: string };

/**
 * Denormalized so a proxied request touches zero SQLite: the hot path is one Map lookup.
 * Mutable counters live here too, so limit enforcement is a field increment.
 */
export type RouteEntry = {
  readonly hostname: string;
  readonly previewId: string;
  /** Which host's containers these are: the proxy dials each host its own way (T36). */
  readonly hostId: string;
  readonly project: string;
  readonly service: string;
  readonly containerPort: number;
  readonly upstreamHost: string;
  upstreamPort: number;
  readonly primary: boolean;
  visibility: Visibility;
  password: EntryPassword;
  /** ADR-0023: whether a gangway login gets past that password; `inherit` is read per request. */
  passwordLogin: PasswordLogin;
  state: PreviewState;
  /** Mutable per-request counters -- see net/limits.ts. */
  inflight: number;
  bytesInFlight: number;
  lastSeenAt: number;
};

export type RouteSeed = {
  route: Route;
  hostId: string;
  project: string;
  visibility: Visibility;
  /** ADR-0023. Omitted: inherit. */
  password?: EntryPassword | undefined;
  passwordLogin?: PasswordLogin | undefined;
  state: PreviewState;
};

function toEntry(s: RouteSeed): RouteEntry {
  return {
    hostname: s.route.hostname,
    previewId: s.route.previewId,
    hostId: s.hostId,
    project: s.project,
    service: s.route.service,
    containerPort: s.route.containerPort,
    upstreamHost: s.route.upstream.host,
    upstreamPort: s.route.upstream.port,
    primary: s.route.primary,
    visibility: s.visibility,
    password: s.password ?? { mode: "inherit" },
    passwordLogin: s.passwordLogin ?? "inherit",
    state: s.state,
    inflight: 0,
    bytesInFlight: 0,
    lastSeenAt: 0,
  };
}

export class RouteTable {
  readonly #byHostname = new Map<string, RouteEntry>();
  readonly #byPreview = new Map<string, Set<string>>();
  /** Preview ids touched since the last `drainSeen()`. */
  readonly #seen = new Set<string>();
  readonly #repo: RoutesRepo;

  constructor(repo: RoutesRepo) {
    this.#repo = repo;
  }

  /** Hot path. Exact match on an already-normalized hostname: no regex, no wildcards. */
  lookup(hostname: string): RouteEntry | undefined {
    return this.#byHostname.get(hostname);
  }

  get size(): number {
    return this.#byHostname.size;
  }

  hostnames(): string[] {
    return [...this.#byHostname.keys()];
  }

  forPreview(previewId: string): RouteEntry[] {
    const names = this.#byPreview.get(previewId);
    if (!names) return [];
    return [...names]
      .map((n) => this.#byHostname.get(n))
      .filter((e): e is RouteEntry => e !== undefined);
  }

  /** Boot load (§11 step 1). Replaces memory wholesale; does not write the database. */
  hydrate(seeds: RouteSeed[]): void {
    this.#byHostname.clear();
    this.#byPreview.clear();
    for (const s of seeds) this.#index(toEntry(s));
  }

  #index(e: RouteEntry): void {
    this.#byHostname.set(e.hostname, e);
    let set = this.#byPreview.get(e.previewId);
    if (!set) {
      set = new Set();
      this.#byPreview.set(e.previewId, set);
    }
    set.add(e.hostname);
  }

  /**
   * Database first, memory second. If the insert throws -- a hostname collision, a
   * duplicate port -- memory is left untouched and the caller sees the error.
   */
  apply(seed: RouteSeed): RouteEntry {
    this.#repo.create({
      hostname: seed.route.hostname,
      previewId: seed.route.previewId,
      service: seed.route.service,
      containerPort: seed.route.containerPort,
      upstream: seed.route.upstream,
      primary: seed.route.primary,
    });
    const entry = toEntry(seed);
    this.#index(entry);
    return entry;
  }

  /** Adopts a route rebuilt from container labels (§11) without re-writing the database. */
  adopt(seed: RouteSeed): RouteEntry {
    const entry = toEntry(seed);
    this.#index(entry);
    return entry;
  }

  updateUpstreamPort(hostname: string, port: number): void {
    const e = this.#byHostname.get(hostname);
    if (!e) return;
    this.#repo.updateUpstream(hostname, { host: e.upstreamHost, port });
    e.upstreamPort = port;
  }

  /**
   * State lives on every entry so the proxy's state machine needs no database read.
   * Touches the preview's routes only -- previews with sixty routes are the exception.
   */
  setState(previewId: string, state: PreviewState): void {
    for (const e of this.forPreview(previewId)) e.state = state;
  }

  setVisibility(previewId: string, visibility: Visibility): void {
    for (const e of this.forPreview(previewId)) e.visibility = visibility;
  }

  setPassword(previewId: string, password: EntryPassword): void {
    for (const e of this.forPreview(previewId)) e.password = password;
  }

  setPasswordLogin(previewId: string, login: PasswordLogin): void {
    for (const e of this.forPreview(previewId)) e.passwordLogin = login;
  }

  /** Called on every proxied request. Memory only -- the database write is batched. */
  touch(hostname: string, at: number): void {
    const e = this.#byHostname.get(hostname);
    if (!e) return;
    e.lastSeenAt = at;
    this.#seen.add(e.previewId);
  }

  /**
   * Previews visited since the last drain, with the newest visit across their routes.
   * Draining clears the set. A flush that then fails to write loses one window of visits,
   * which the next request to that preview repairs; not worth a hand-back protocol.
   */
  drainSeen(): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of this.#seen) {
      let at = 0;
      for (const e of this.forPreview(id)) at = Math.max(at, e.lastSeenAt);
      if (at > 0) out.set(id, at);
    }
    this.#seen.clear();
    return out;
  }

  removePreview(previewId: string): number {
    const names = this.#byPreview.get(previewId);
    if (!names) return 0;
    this.#repo.deleteForPreview(previewId);
    for (const n of names) this.#byHostname.delete(n);
    this.#byPreview.delete(previewId);
    return names.size;
  }

  /** Removes one route from memory only -- used when stopping an adopted orphan. */
  evict(hostname: string): void {
    const e = this.#byHostname.get(hostname);
    if (!e) return;
    this.#byHostname.delete(hostname);
    const set = this.#byPreview.get(e.previewId);
    set?.delete(hostname);
    if (set && set.size === 0) this.#byPreview.delete(e.previewId);
  }

  /** Ports in use on a host, for the allocator. Reads memory, not the database. */
  usedPorts(upstreamHost: string): Set<number> {
    const out = new Set<number>();
    for (const e of this.#byHostname.values()) {
      if (e.upstreamHost === upstreamHost) out.add(e.upstreamPort);
    }
    return out;
  }
}
