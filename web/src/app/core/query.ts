import { Injectable, computed, signal, type Signal, type WritableSignal } from '@angular/core';
import { toProblem, type ProblemError } from './problem';

export type Query<T> = {
  data: Signal<T | undefined>;
  error: Signal<ProblemError | null>;
  loaded: Signal<boolean>;
  refresh: () => Promise<void>;
};

const isProblem = (e: unknown): e is ProblemError =>
  typeof e === 'object' && e !== null && 'status' in e && 'detail' in e && 'issues' in e;

type Entry = {
  data: WritableSignal<unknown>;
  error: WritableSignal<ProblemError | null>;
  inflight: Promise<void> | null;
  load: () => Promise<unknown>;
};

/** Answers kept by key: a page shows the last one at once and fetches a fresh one behind it. */
@Injectable({ providedIn: 'root' })
export class QueryCache {
  readonly #entries = new Map<string, Entry>();

  /** The query for `key`, refreshed now unless a refresh is already on its way. */
  query<T>(key: string, load: () => Promise<T>): Query<T> {
    let e = this.#entries.get(key);
    if (!e) {
      e = { data: signal<unknown>(undefined), error: signal(null), inflight: null, load };
      this.#entries.set(key, e);
    }
    e.load = load;
    const entry = e;
    const refresh = () => this.#refresh(entry);
    void refresh();
    return {
      data: entry.data.asReadonly() as Signal<T | undefined>,
      error: entry.error.asReadonly(),
      loaded: computed(() => entry.data() !== undefined),
      refresh,
    };
  }

  /** Sets a key's answer by hand, after a write that changed it. */
  set<T>(key: string, value: T): void {
    this.#entries.get(key)?.data.set(value);
  }

  invalidate(prefix: string): void {
    for (const key of [...this.#entries.keys()])
      if (key.startsWith(prefix)) this.#entries.delete(key);
  }

  #refresh(e: Entry): Promise<void> {
    return (e.inflight ??= e
      .load()
      .then(
        (v) => {
          e.data.set(v);
          e.error.set(null);
        },
        (err: unknown) => e.error.set(isProblem(err) ? err : toProblem(err)),
      )
      .finally(() => {
        e.inflight = null;
      }));
  }
}
