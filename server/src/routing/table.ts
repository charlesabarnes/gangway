import type { PasswordLogin, PreviewState, Route, Visibility } from "@gangway/shared/domain";
import type { RoutesRepo } from "../db/repos/routes.ts";

export type EntryPassword =
  { mode: "inherit" } | { mode: "none" } | { mode: "own"; hash: string; salt: string };

export type RouteEntry = {
  readonly hostname: string;
  readonly previewId: string;
  readonly hostId: string;
  readonly project: string;
  readonly service: string;
  readonly containerPort: number;
  readonly upstreamHost: string;
  upstreamPort: number;
  readonly primary: boolean;
  visibility: Visibility;
  password: EntryPassword;
  passwordLogin: PasswordLogin;
  state: PreviewState;
  /** Answered from the preview's files by gangway, not proxied to a container. */
  site: boolean;
  inflight: number;
  bytesInFlight: number;
  lastSeenAt: number;
};

export type RouteSeed = {
  route: Route;
  hostId: string;
  project: string;
  visibility: Visibility;
  password?: EntryPassword | undefined;
  passwordLogin?: PasswordLogin | undefined;
  state: PreviewState;
  site?: boolean | undefined;
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
    site: s.site ?? false,
    inflight: 0,
    bytesInFlight: 0,
    lastSeenAt: 0,
  };
}

/** The preview a custom hostname answers for, if it is one. */
export type AliasResolver = (hostname: string) => string | undefined;

export class RouteTable {
  readonly #byHostname = new Map<string, RouteEntry>();
  readonly #byPreview = new Map<string, Set<string>>();
  readonly #aliases = new Map<string, RouteEntry>();
  readonly #seen = new Set<string>();
  readonly #repo: RoutesRepo;
  readonly #aliasOf: AliasResolver | undefined;

  constructor(repo: RoutesRepo, aliasOf?: AliasResolver) {
    this.#repo = repo;
    this.#aliasOf = aliasOf;
  }

  /** A preview's own hostname, or a custom hostname standing in for its primary route. */
  lookup(hostname: string): RouteEntry | undefined {
    return this.#byHostname.get(hostname) ?? this.#alias(hostname);
  }

  // Reads fall through to the preview's own entry, so its state, visibility, password and
  // upstream port stay in step; the name and the request counters are the alias's own.
  #alias(hostname: string): RouteEntry | undefined {
    const previewId = this.#aliasOf?.(hostname);
    const routes = previewId ? this.forPreview(previewId) : [];
    const primary = routes.find((e) => e.primary) ?? routes[0];
    if (!primary) {
      this.#aliases.delete(hostname);
      return undefined;
    }
    const cached = this.#aliases.get(hostname);
    if (cached && Object.getPrototypeOf(cached) === primary) {
      return cached;
    }
    const own = (value: unknown) => ({ value, writable: true, enumerable: true });
    const entry = Object.create(primary, {
      hostname: { value: hostname, enumerable: true },
      inflight: own(0),
      bytesInFlight: own(0),
      lastSeenAt: own(0),
    }) as RouteEntry;
    this.#aliases.set(hostname, entry);
    return entry;
  }

  /** The preview's own entry behind a custom hostname's. */
  canonical(entry: RouteEntry): RouteEntry {
    return this.#byHostname.get(entry.hostname) === entry
      ? entry
      : (Object.getPrototypeOf(entry) as RouteEntry);
  }

  get size(): number {
    return this.#byHostname.size;
  }

  hostnames(): string[] {
    return [...this.#byHostname.keys()];
  }

  forPreview(previewId: string): RouteEntry[] {
    const names = this.#byPreview.get(previewId);
    if (!names) {
      return [];
    }
    return [...names]
      .map((n) => this.#byHostname.get(n))
      .filter((e): e is RouteEntry => e !== undefined);
  }

  hydrate(seeds: RouteSeed[]): void {
    this.#byHostname.clear();
    this.#byPreview.clear();
    for (const s of seeds) {
      this.#index(toEntry(s));
    }
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

  // SQLite first, memory second, with no await between, so no request sees a half-applied state.
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

  adopt(seed: RouteSeed): RouteEntry {
    const entry = toEntry(seed);
    this.#index(entry);
    return entry;
  }

  /**
   * Names every route of a preview under another domain, keeping each label and upstream. Throws
   * before changing anything when a new name is another preview's.
   */
  moveToDomain(previewId: string, domain: string): Map<string, string> {
    const moves = new Map<string, string>();
    for (const e of this.forPreview(previewId)) {
      const to = `${e.hostname.split(".")[0]}.${domain}`;
      if (to === e.hostname) {
        continue;
      }
      const taken = this.#byHostname.get(to);
      if (taken && taken.previewId !== previewId) {
        throw new Error(`${to} is already another preview's hostname`);
      }
      moves.set(e.hostname, to);
    }
    return this.#rename(previewId, moves);
  }

  /** Names a preview's hostnames with a new stem, as `moveToDomain` moves them to a new domain. */
  relabel(previewId: string, from: string, to: string): Map<string, string> {
    const moves = new Map<string, string>();
    for (const e of this.forPreview(previewId)) {
      const [label = "", ...rest] = e.hostname.split(".");
      if (label !== from && !label.startsWith(`${from}-`)) {
        continue;
      }
      const next = [to + label.slice(from.length), ...rest].join(".");
      const taken = this.#byHostname.get(next);
      if (taken && taken.previewId !== previewId) {
        throw new Error(`${next} is already another preview's hostname`);
      }
      moves.set(e.hostname, next);
    }
    return this.#rename(previewId, moves);
  }

  #rename(previewId: string, moves: Map<string, string>): Map<string, string> {
    if (moves.size === 0) {
      return moves;
    }
    this.#repo.rename(moves);
    const entries = this.forPreview(previewId);
    for (const e of entries) {
      this.#byHostname.delete(e.hostname);
    }
    this.#byPreview.delete(previewId);
    for (const e of entries) {
      const to = moves.get(e.hostname);
      this.#index(to ? { ...e, hostname: to } : e);
    }
    return moves;
  }

  updateUpstreamPort(hostname: string, port: number): void {
    const e = this.#byHostname.get(hostname);
    if (!e) {
      return;
    }
    this.#repo.updateUpstream(hostname, { host: e.upstreamHost, port });
    e.upstreamPort = port;
  }

  setState(previewId: string, state: PreviewState): void {
    for (const e of this.forPreview(previewId)) {
      e.state = state;
    }
  }

  setSite(previewId: string, site: boolean): void {
    for (const e of this.forPreview(previewId)) {
      e.site = site;
    }
  }

  setVisibility(previewId: string, visibility: Visibility): void {
    for (const e of this.forPreview(previewId)) {
      e.visibility = visibility;
    }
  }

  setPassword(previewId: string, password: EntryPassword): void {
    for (const e of this.forPreview(previewId)) {
      e.password = password;
    }
  }

  setPasswordLogin(previewId: string, login: PasswordLogin): void {
    for (const e of this.forPreview(previewId)) {
      e.passwordLogin = login;
    }
  }

  touch(hostname: string, at: number): void {
    const found = this.lookup(hostname);
    if (!found) {
      return;
    }
    const e = this.canonical(found);
    e.lastSeenAt = at;
    this.#seen.add(e.previewId);
  }

  drainSeen(): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of this.#seen) {
      let at = 0;
      for (const e of this.forPreview(id)) {
        at = Math.max(at, e.lastSeenAt);
      }
      if (at > 0) {
        out.set(id, at);
      }
    }
    this.#seen.clear();
    return out;
  }

  removePreview(previewId: string): number {
    const names = this.#byPreview.get(previewId);
    if (!names) {
      return 0;
    }
    this.#repo.deleteForPreview(previewId);
    for (const n of names) {
      this.#byHostname.delete(n);
    }
    this.#byPreview.delete(previewId);
    return names.size;
  }

  evict(hostname: string): void {
    const e = this.#byHostname.get(hostname);
    if (!e) {
      return;
    }
    this.#byHostname.delete(hostname);
    const set = this.#byPreview.get(e.previewId);
    set?.delete(hostname);
    if (set?.size === 0) {
      this.#byPreview.delete(e.previewId);
    }
  }

  usedPorts(upstreamHost: string): Set<number> {
    const out = new Set<number>();
    for (const e of this.#byHostname.values()) {
      if (e.upstreamHost === upstreamHost) {
        out.add(e.upstreamPort);
      }
    }
    return out;
  }
}
