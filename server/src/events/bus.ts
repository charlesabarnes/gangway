import type { GangwayEvent } from "@gangway/shared/domain";
import type { EventsRepo } from "../db/repos/events.ts";

export type EventListener = (e: GangwayEvent) => void;

export class EventBus {
  readonly #repo: EventsRepo;
  readonly #listeners = new Set<EventListener>();
  readonly #onListenerError: (e: unknown) => void;

  constructor(repo: EventsRepo, onListenerError: (e: unknown) => void = () => {}) {
    this.#repo = repo;
    this.#onListenerError = onListenerError;
  }

  publish(
    type: string,
    payload: Record<string, unknown> = {},
    previewId: string | null = null,
  ): GangwayEvent {
    const event = this.#repo.append(type, payload, previewId);
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch (e) {
        this.#onListenerError(e);
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Read before listing, so a change in between is replayed rather than missed.
  latestSeq(): number {
    return this.#repo.latestSeq();
  }

  history(previewId: string, limit = 200): GangwayEvent[] {
    return this.#repo.forPreview(previewId, limit);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  // Subscribe before reading the backlog, then drop buffered events it already covered.
  follow(afterSeq: number, deliver: EventListener, previewId?: string): () => void {
    const PAGE = 200;
    const MAX_PAGES = 5;
    let cursor = afterSeq;
    let replaying = true;
    const buffered: GangwayEvent[] = [];
    const wanted = (e: GangwayEvent) => previewId === undefined || e.previewId === previewId;
    const emit = (e: GangwayEvent) => {
      if (e.seq <= cursor || !wanted(e)) return;
      cursor = e.seq;
      deliver(e);
    };

    const unsubscribe = this.subscribe((e) => (replaying ? buffered.push(e) : emit(e)));

    for (let pages = 0; ; pages++) {
      if (pages === MAX_PAGES) {
        const seq = this.#repo.latestSeq();
        emit({
          seq,
          previewId: previewId ?? null,
          type: "reset",
          payload: { reason: "backlog" },
          createdAt: new Date(),
        });
        break;
      }
      const page = this.#repo.since(cursor, PAGE, previewId);
      for (const e of page) emit(e);
      if (page.length < PAGE) break;
    }
    replaying = false;
    for (const e of buffered) emit(e);

    return unsubscribe;
  }
}
