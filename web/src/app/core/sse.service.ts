import { HttpClient } from '@angular/common/http';
import { DOCUMENT, Injectable, InjectionToken, inject, signal, type Signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { SessionInfo } from './api.types';
import { AuthService } from './auth.service';

export type EventSourceLike = {
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
};

export const EVENT_SOURCE_FACTORY = new InjectionToken<(url: string) => EventSourceLike>(
  'EVENT_SOURCE_FACTORY',
  {
    providedIn: 'root',
    factory: () => (url: string) => new EventSource(url),
  },
);

export const SSE_JITTER = new InjectionToken<() => number>('SSE_JITTER', {
  providedIn: 'root',
  factory: () => Math.random,
});

export type SseStatus = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'closed';
export type SseMessage<T> = { type: string; data: T; id: string };
export type SseHandle = { readonly status: Signal<SseStatus>; close(): void };

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000];
const HIDDEN_GRACE_MS = 30_000;
const PROBE_AFTER_FAILURES = 2;

type Stream<T> = {
  url: string;
  types: readonly string[];
  onMessage: (m: SseMessage<T>) => void;
  after: string;
};
type Deps = {
  factory: (url: string) => EventSourceLike;
  jitter: () => number;
  doc: Document;
  loggedOut: () => Promise<boolean>;
  signOut: () => void;
};

class SseConnection<T> {
  readonly status = signal<SseStatus>('connecting');
  #source: EventSourceLike | null = null;
  #lastId: string;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  #done = false;
  readonly #onVisibility = () => this.#visibilityChanged();

  readonly #stream: Stream<T>;
  readonly #deps: Deps;

  constructor(stream: Stream<T>, deps: Deps) {
    this.#stream = stream;
    this.#deps = deps;
    this.#lastId = stream.after;
    deps.doc.addEventListener('visibilitychange', this.#onVisibility);
    this.#connect();
  }

  close(): void {
    if (this.#done) return;
    this.#done = true;
    this.#clearRetry();
    if (this.#hiddenTimer) clearTimeout(this.#hiddenTimer);
    this.#deps.doc.removeEventListener('visibilitychange', this.#onVisibility);
    this.#drop();
    this.status.set('closed');
  }

  #drop(): void {
    this.#source?.close();
    this.#source = null;
  }

  #clearRetry(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }

  #connect(): void {
    if (this.#done) return;
    this.#drop();
    const { url } = this.#stream;
    // Callers pass the cursor as o.after: a url with its own after would send two.
    const at =
      this.#lastId === ''
        ? url
        : `${url}${url.includes('?') ? '&' : '?'}after=${encodeURIComponent(this.#lastId)}`;
    const s = (this.#source = this.#deps.factory(at));
    s.onopen = () => {
      if (s !== this.#source) return;
      this.#failures = 0;
      this.status.set('live');
    };
    s.onerror = () => {
      if (s === this.#source) void this.#failed();
    };
    for (const type of this.#stream.types)
      s.addEventListener(type, (e) => {
        if (s === this.#source) this.#message(type, e);
      });
  }

  #message(type: string, e: MessageEvent): void {
    if (e.lastEventId) this.#lastId = e.lastEventId;
    let data: T;
    try {
      data = JSON.parse(String(e.data)) as T;
    } catch {
      return;
    }
    this.#stream.onMessage({ type, data, id: e.lastEventId });
  }

  async #failed(): Promise<void> {
    this.#drop();
    if (this.#done) return;
    this.#failures++;
    this.status.set('reconnecting');
    if (this.#failures >= PROBE_AFTER_FAILURES && (await this.#deps.loggedOut())) {
      this.close();
      this.#deps.signOut();
      return;
    }
    if (this.#done || this.status() === 'paused') return;
    const base = BACKOFF_MS[Math.min(this.#failures - 1, BACKOFF_MS.length - 1)]!;
    this.#clearRetry();
    this.#retry = setTimeout(
      () => this.#connect(),
      Math.round(base * (1 + 0.2 * this.#deps.jitter())),
    );
  }

  #visibilityChanged(): void {
    if (this.#done) return;
    if (this.#deps.doc.visibilityState === 'hidden') {
      this.#hiddenTimer ??= setTimeout(() => this.#pause(), HIDDEN_GRACE_MS);
      return;
    }
    if (this.#hiddenTimer) {
      clearTimeout(this.#hiddenTimer);
      this.#hiddenTimer = null;
    }
    if (this.status() === 'paused') {
      this.status.set('connecting');
      this.#failures = 0;
      this.#connect();
    }
  }

  #pause(): void {
    this.#hiddenTimer = null;
    this.#clearRetry();
    this.#drop();
    this.status.set('paused');
  }
}

@Injectable({ providedIn: 'root' })
export class SseService {
  readonly #factory = inject(EVENT_SOURCE_FACTORY);
  readonly #jitter = inject(SSE_JITTER);
  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);
  readonly #doc = inject(DOCUMENT);

  open<T>(
    url: string,
    types: readonly string[],
    onMessage: (m: SseMessage<T>) => void,
    o: { after?: string | number } = {},
  ): SseHandle {
    const after = o.after === undefined ? '' : String(o.after);
    const c = new SseConnection<T>(
      { url, types, onMessage, after },
      {
        factory: this.#factory,
        jitter: this.#jitter,
        doc: this.#doc,
        loggedOut: () => this.#loggedOut(),
        signOut: () => this.#signOut(),
      },
    );
    return { status: c.status.asReadonly(), close: () => c.close() };
  }

  #signOut(): void {
    this.#auth.clear();
    const at = this.#router.url;
    void this.#router.navigate(['/login'], {
      queryParams: at === '/' ? {} : { returnUrl: at },
    });
  }

  async #loggedOut(): Promise<boolean> {
    try {
      return !(await firstValueFrom(this.#http.get<SessionInfo>('/v1/auth/session'))).authenticated;
    } catch {
      return false;
    }
  }
}
