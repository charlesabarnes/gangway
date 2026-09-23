/**
 * jsdom has no EventSource, and a real one could not be driven from a test anyway. This is
 * the part of the interface SseService uses, plus handles to push events and failures.
 */
type Listener = (e: MessageEvent) => void;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  }

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, l: Listener): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(l);
  }

  removeEventListener(type: string, l: Listener): void {
    this.#listeners.get(type)?.delete(l);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /* ---- test handles */

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  emit(type: string, data: unknown, id = ''): void {
    const e = new MessageEvent(type, {
      data: typeof data === 'string' ? data : JSON.stringify(data),
      lastEventId: id,
    });
    for (const l of this.#listeners.get(type) ?? []) l(e);
  }

  /** What a dropped connection, a 503 while draining, or a proxy's 502 all look like: no status, just this. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }

  listensTo(type: string): boolean {
    return (this.#listeners.get(type)?.size ?? 0) > 0;
  }
}
