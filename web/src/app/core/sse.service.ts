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
    const status = signal<SseStatus>('connecting');
    let source: EventSourceLike | null = null;
    let lastId = o.after === undefined ? '' : String(o.after);
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const drop = () => {
      source?.close();
      source = null;
    };
    const clearRetry = () => {
      if (retry) clearTimeout(retry);
      retry = null;
    };

    const connect = () => {
      if (done) return;
      drop();
      // Callers pass the cursor as o.after: a url with its own after would send two.
      const at =
        lastId === ''
          ? url
          : `${url}${url.includes('?') ? '&' : '?'}after=${encodeURIComponent(lastId)}`;
      const s = (source = this.#factory(at));
      s.onopen = () => {
        if (s === source) {
          failures = 0;
          status.set('live');
        }
      };
      s.onerror = () => {
        if (s === source) void failed();
      };
      for (const type of types) {
        s.addEventListener(type, (e) => {
          if (s !== source) return;
          if (e.lastEventId) lastId = e.lastEventId;
          let data: T;
          try {
            data = JSON.parse(String(e.data)) as T;
          } catch {
            return;
          }
          onMessage({ type, data, id: e.lastEventId });
        });
      }
    };

    const failed = async () => {
      drop();
      if (done) return;
      failures++;
      status.set('reconnecting');
      if (failures >= PROBE_AFTER_FAILURES && (await this.#loggedOut())) {
        close();
        this.#auth.clear();
        const at = this.#router.url;
        void this.#router.navigate(['/login'], {
          queryParams: at === '/' ? {} : { returnUrl: at },
        });
        return;
      }
      if (done || status() === 'paused') return;
      const base = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]!;
      clearRetry();
      retry = setTimeout(connect, Math.round(base * (1 + 0.2 * this.#jitter())));
    };

    const onVisibility = () => {
      if (done) return;
      if (this.#doc.visibilityState === 'hidden') {
        hiddenTimer ??= setTimeout(() => {
          hiddenTimer = null;
          clearRetry();
          drop();
          status.set('paused');
        }, HIDDEN_GRACE_MS);
        return;
      }
      if (hiddenTimer) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
      if (status() === 'paused') {
        status.set('connecting');
        failures = 0;
        connect();
      }
    };

    const close = () => {
      if (done) return;
      done = true;
      clearRetry();
      if (hiddenTimer) clearTimeout(hiddenTimer);
      this.#doc.removeEventListener('visibilitychange', onVisibility);
      drop();
      status.set('closed');
    };

    this.#doc.addEventListener('visibilitychange', onVisibility);
    connect();
    return { status: status.asReadonly(), close };
  }

  async #loggedOut(): Promise<boolean> {
    try {
      return !(await firstValueFrom(this.#http.get<SessionInfo>('/v1/auth/session'))).authenticated;
    } catch {
      return false;
    }
  }
}
