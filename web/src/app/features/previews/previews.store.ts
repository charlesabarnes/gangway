import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  STREAM_EVENT_TYPES,
  type PasswordChange,
  type Preview,
  type PreviewList,
  type StreamEvent,
} from '../../core/api.types';
import { toProblem, type ProblemError } from '../../core/problem';
import { SseService, type SseHandle, type SseStatus } from '../../core/sse.service';

/** How long a preview that was destroyed while you watched stays on screen, greyed, before it goes. */
export const DESTROYED_LINGER_MS = 10_000;

type Patch = Omit<StreamEvent, 'type'> & { type: StreamEvent['type'] };
export type RedeployEvent = Extract<StreamEvent, { type: 'preview.redeploy' }>;

/**
 * The previews on screen, kept live. One fetch, then `/v1/events` from the cursor that
 * fetch returned -- the server reads that cursor BEFORE the list, so a change landing in
 * between is replayed onto a list that already has it, never missed.
 *
 * Shared by the list and the detail page (root-provided, ref-counted), so going from one
 * to the other neither refetches nor opens a second stream.
 */
@Injectable({ providedIn: 'root' })
export class PreviewsStore {
  readonly #http = inject(HttpClient);
  readonly #sse = inject(SseService);

  readonly #byId = signal<ReadonlyMap<string, Preview>>(new Map());
  readonly #handle = signal<SseHandle | null>(null);
  readonly loading = signal(false);
  readonly error = signal<ProblemError | null>(null);
  readonly includeDestroyed = signal(false);

  /** Newest first: ids are ULIDs, so they sort by creation time. */
  readonly previews = computed(() =>
    [...this.#byId().values()].sort((a, b) => (a.id < b.id ? 1 : -1)),
  );
  readonly status: Signal<SseStatus | 'idle'> = computed(() => this.#handle()?.status() ?? 'idle');

  #users = 0;
  readonly #fetching = new Map<string, Promise<Preview | undefined>>();
  readonly #dropTimers = new Map<string, ReturnType<typeof setTimeout>>();

  byId(id: string): Signal<Preview | undefined> {
    return computed(() => this.#byId().get(id));
  }

  /** Call from a component that shows previews; pair with `disconnect()` on destroy. */
  connect(): void {
    if (++this.#users === 1) void this.reload();
  }

  disconnect(): void {
    if (this.#users === 0 || --this.#users > 0) return;
    this.#handle()?.close();
    this.#handle.set(null);
    for (const t of this.#dropTimers.values()) clearTimeout(t);
    this.#dropTimers.clear();
  }

  /** Fetch everything and (re)start following. Also what a `reset` event asks for. */
  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const q = this.includeDestroyed() ? '?includeDestroyed=true' : '';
      const list = await firstValueFrom(this.#http.get<PreviewList>(`/v1/previews${q}`));
      this.#byId.set(new Map(list.previews.map((p) => [p.id, p])));
      this.error.set(null);
      if (this.#users > 0) this.#follow(list.seq);
    } catch (e) {
      this.error.set(toProblem(e));
    } finally {
      this.loading.set(false);
    }
  }

  async setIncludeDestroyed(on: boolean): Promise<void> {
    if (this.includeDestroyed() === on) return;
    this.includeDestroyed.set(on);
    await this.reload();
  }

  /** One preview into the store: a deep link to a detail page, or an event about an id not held yet. */
  load(id: string): Promise<Preview | undefined> {
    const running = this.#fetching.get(id);
    if (running) return running;
    const p = firstValueFrom(this.#http.get<{ preview: Preview }>(`/v1/previews/${id}`))
      .then(({ preview }) => {
        this.#put(preview);
        return preview as Preview | undefined;
      })
      .catch(() => undefined)
      .finally(() => this.#fetching.delete(id));
    this.#fetching.set(id, p);
    return p;
  }

  /**
   * Optimistic: the row says `destroying` at once, and goes back to what it was if the
   * server refuses. Rejects with a ProblemError the caller can show.
   */
  async destroy(id: string): Promise<void> {
    const before = this.#byId().get(id);
    if (before) this.#put({ ...before, state: 'destroying' });
    try {
      const { preview } = await firstValueFrom(
        this.#http.delete<{ preview: Preview }>(`/v1/previews/${id}`),
      );
      this.#put(preview);
    } catch (e) {
      // Only if nothing newer arrived meanwhile: an event may already have moved it on.
      if (before && this.#byId().get(id)?.state === 'destroying') this.#put(before);
      throw toProblem(e);
    }
  }

  /** ADR-0023: change a preview's password and/or its login rule. Rejects with a ProblemError the caller can show. */
  async setPassword(id: string, change: PasswordChange): Promise<Preview> {
    try {
      const { preview } = await firstValueFrom(
        this.#http.put<{ preview: Preview }>(`/v1/previews/${id}/password`, change),
      );
      this.#put(preview);
      return preview;
    } catch (e) {
      throw toProblem(e);
    }
  }

  #follow(seq: number): void {
    this.#handle()?.close();
    this.#handle.set(
      this.#sse.open<Patch>(
        '/v1/events',
        STREAM_EVENT_TYPES,
        (m) => this.#on({ ...m.data, type: m.type as StreamEvent['type'] } as StreamEvent),
        { after: seq },
      ),
    );
  }

  #on(e: StreamEvent): void {
    if (e.type === 'reset') {
      void this.reload();
      return;
    }
    if (e.type === 'preview.redeploy') {
      this.#noteRedeploy(e);
      return;
    }
    // created/adopted carry no preview; an event about an id not held is the same problem.
    const held = this.#byId().get(e.previewId);
    if (e.type !== 'preview.state' || !held) {
      void this.load(e.previewId);
      return;
    }
    // The replay after a reconnect can include events OLDER than the row just fetched.
    if (Date.parse(e.at) < Date.parse(held.updatedAt)) return;
    this.#put({
      ...held,
      state: e.state,
      error: e.error ?? null,
      updatedAt: e.at,
      ...(e.state === 'destroyed' ? { destroyedAt: e.at } : {}),
    });
  }

  /** The latest `preview.redeploy` per preview (ADR-0015): the Source panel shows its phase. */
  readonly #redeploys = signal<ReadonlyMap<string, RedeployEvent>>(new Map());

  redeployOf(id: string): Signal<RedeployEvent | undefined> {
    return computed(() => this.#redeploys().get(id));
  }

  #noteRedeploy(e: RedeployEvent): void {
    const held = this.#redeploys().get(e.previewId);
    if (held && Date.parse(e.at) < Date.parse(held.at)) return;
    const next = new Map(this.#redeploys());
    next.set(e.previewId, e);
    this.#redeploys.set(next);
  }

  #put(p: Preview): void {
    const next = new Map(this.#byId());
    next.set(p.id, p);
    this.#byId.set(next);
    if (p.state !== 'destroyed' || this.includeDestroyed() || this.#dropTimers.has(p.id)) return;
    this.#dropTimers.set(
      p.id,
      setTimeout(() => {
        this.#dropTimers.delete(p.id);
        if (this.includeDestroyed() || this.#byId().get(p.id)?.state !== 'destroyed') return;
        const without = new Map(this.#byId());
        without.delete(p.id);
        this.#byId.set(without);
      }, DESTROYED_LINGER_MS),
    );
  }
}
