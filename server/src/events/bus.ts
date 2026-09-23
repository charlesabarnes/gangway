/**
 * The event bus: every state change is appended to SQLite FIRST and fanned out to live
 * subscribers second. The table is the SSE backlog, so a client that reconnects with
 * Last-Event-ID replays exactly what it missed (see db/repos/events.ts).
 */
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
      // One broken SSE client must not stop a deploy from publishing to the others.
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

  /**
   * The cursor to follow FROM. A client that lists previews and then opens the stream must
   * read this BEFORE the list: a change landing in between is then replayed (harmlessly,
   * it is already in the list) rather than missed.
   */
  latestSeq(): number {
    return this.#repo.latestSeq();
  }

  /** One preview's history, oldest first. Gone when the preview row is: the FK cascades. */
  history(previewId: string, limit = 200): GangwayEvent[] {
    return this.#repo.forPreview(previewId, limit);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /**
   * Replay-then-follow with no gap and no duplicate: subscribe BEFORE reading the
   * backlog, buffer what arrives meanwhile, then drop anything the backlog already
   * covered. A client more than 1000 events behind gets one synthetic `reset` instead of
   * the backlog. Returns the unsubscribe function.
   */
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
        // Too far behind to replay. Say so rather than silently skipping: the client
        // drops what it has and refetches, then follows from here.
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
