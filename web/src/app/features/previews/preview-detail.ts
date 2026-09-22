import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { Build, PreviewEvent } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { EmptyState } from '../../ui/empty-state';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { StateBadge } from '../../ui/state-badge';
import { ToastService } from '../../ui/toast';
import { LogViewer } from './log-viewer';
import { PreviewsStore } from './previews.store';
import { displayName, sourceLabel } from './source-label';

@Component({
  selector: 'app-preview-detail',
  imports: [RouterLink, Btn, ConfirmDialog, EmptyState, LogViewer, RelativeTimePipe, StateBadge],
  template: `
    <section class="mx-auto max-w-5xl px-6 py-10">
      <a routerLink="/previews" class="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">← Previews</a>

      @if (preview(); as p) {
        <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 class="text-2xl font-semibold tracking-tight" data-testid="title">{{ name() }}</h1>
          <app-state-badge [state]="p.state" />
          <span class="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 dark:border-neutral-700" data-testid="visibility">{{ p.visibility }}</span>
          @if (canDestroy() && p.state !== 'destroying' && p.state !== 'destroyed') {
            <button appBtn variant="danger" type="button" class="ml-auto" (click)="dialog().open()" data-testid="destroy">Destroy</button>
          }
        </div>

        @if (p.state === 'failed' && p.error) {
          <div class="mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300" role="alert" data-testid="failure">
            <p class="font-medium">This preview failed.</p>
            <p class="mt-1 font-mono text-xs break-words whitespace-pre-wrap">{{ p.error }}</p>
          </div>
        }

        <div class="mt-8 grid gap-8 md:grid-cols-3">
          <div class="md:col-span-2">
            <h2 class="text-sm font-medium text-neutral-500">URLs</h2>
            <ul class="mt-2 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              @for (u of p.urls; track u.url) {
                <li class="flex items-center gap-3 px-4 py-2.5 text-sm" data-testid="url-row">
                  <span class="w-24 shrink-0 truncate text-neutral-500">{{ u.service }}@if (u.primary) { <span class="ml-1 text-xs text-accent">primary</span> }</span>
                  <a [href]="u.url" target="_blank" rel="noopener noreferrer" class="min-w-0 flex-1 truncate font-mono text-xs hover:text-accent">{{ u.url }}</a>
                  <button type="button" (click)="copy(u.url)" class="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100" data-testid="copy">Copy</button>
                </li>
              } @empty { <li class="px-4 py-2.5 text-sm text-neutral-500">No routes.</li> }
            </ul>
          </div>

          <dl class="space-y-3 text-sm" data-testid="facts">
            <div><dt class="text-neutral-500">Source</dt><dd class="mt-0.5 break-words"><span class="mr-1.5 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">{{ p.source.kind }}</span>{{ source() }}</dd></div>
            @if (p.state === 'destroyed') {
              <!-- "Expires in 59 min" under something already gone reads as if it were still there. -->
              <div><dt class="text-neutral-500">Destroyed</dt><dd class="mt-0.5" [title]="p.destroyedAt ?? ''" data-testid="ttl">{{ p.destroyedAt ? (p.destroyedAt | relativeTime: clock.now()) : 'yes' }}</dd></div>
            } @else {
              @if (p.secretLevel) { <div><dt class="text-neutral-500">Secrets</dt><dd class="mt-0.5" data-testid="secret-level">{{ p.secretLevel }}{{ p.secretLevel === 'none' ? ' (no .env)' : '' }}</dd></div> }
              <div><dt class="text-neutral-500">Expires</dt><dd class="mt-0.5" [title]="p.ttlExpiresAt ?? ''" data-testid="ttl">{{ p.ttlExpiresAt ? (p.ttlExpiresAt | relativeTime: clock.now()) : 'never' }}</dd></div>
            }
            <div><dt class="text-neutral-500">Created</dt><dd class="mt-0.5" [title]="p.createdAt">{{ p.createdAt | relativeTime: clock.now() }}</dd></div>
            <div><dt class="text-neutral-500">Last visited</dt><dd class="mt-0.5" [title]="p.lastSeenAt ?? ''">{{ p.lastSeenAt ? (p.lastSeenAt | relativeTime: clock.now()) : 'not yet' }}</dd></div>
            <div><dt class="text-neutral-500">Host</dt><dd class="mt-0.5 font-mono text-xs">{{ p.hostId }}</dd></div>
          </dl>
        </div>

        @if (canReadLogs()) {
          <h2 class="mt-10 text-sm font-medium text-neutral-500">Logs</h2>
          <div class="mt-2">
            @if (p.state === 'destroyed') {
              <p class="rounded-lg border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700" data-testid="logs-gone">Logs are deleted when a preview is destroyed.</p>
            } @else {
              <app-log-viewer [previewId]="p.id" />
            }
          </div>
        }

        @if (builds().length > 0) {
          <h2 class="mt-10 text-sm font-medium text-neutral-500">Builds <span class="font-normal">— output is in the log above, on the <code class="font-mono text-xs">build</code> stream</span></h2>
          <ul class="mt-2 space-y-1 text-sm" data-testid="builds">
            @for (b of builds(); track b.id) {
              <li class="flex gap-3"><span class="w-20" [class]="b.state === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-400'">{{ b.state }}</span>
                <span class="text-neutral-500">{{ b.service ?? 'all services' }}</span><span class="ml-auto text-neutral-500" [title]="b.startedAt">{{ b.startedAt | relativeTime: clock.now() }}</span></li>
            }
          </ul>
        }

        @if (events().length > 0) {
          <h2 class="mt-10 text-sm font-medium text-neutral-500">History</h2>
          <ol class="mt-2 space-y-1 text-sm" data-testid="events">
            @for (e of events(); track e.seq) {
              <li class="flex gap-3">
                <span class="w-28 shrink-0 text-neutral-500" [title]="e.at">{{ e.at | relativeTime: clock.now() }}</span>
                <span>@if (e.type === 'preview.state') { {{ e.from }} → <span class="font-medium">{{ e.state }}</span> } @else { {{ e.type.replace('preview.', '') }} }</span>
                @if (e.error) { <span class="min-w-0 truncate text-red-600 dark:text-red-400" [title]="e.error">{{ e.error }}</span> }
              </li>
            }
          </ol>
        }

        <app-confirm-dialog [heading]="'Destroy ' + name() + '?'" confirmLabel="Destroy" (confirmed)="destroy()">
          Its containers, volumes and network are removed, its URL stops working, and its logs are deleted. This cannot be undone.
        </app-confirm-dialog>
      } @else if (missing()) {
        <div class="mt-8">
          <app-empty-state heading="No such preview">
            It may have been destroyed — destroyed previews are kept only briefly. <a routerLink="/previews" class="text-accent hover:underline">Back to the list</a>.
          </app-empty-state>
        </div>
      } @else {
        <p class="mt-8 text-sm text-neutral-500" data-testid="loading">Loading…</p>
      }
    </section>
  `,
})
export class PreviewDetail {
  /** From the route, via withComponentInputBinding. */
  readonly id = input.required<string>();

  protected readonly clock = inject(Clock);
  readonly #store = inject(PreviewsStore);
  readonly #auth = inject(AuthService);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  protected readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly preview = computed(() => this.#store.byId(this.id())());
  protected readonly name = computed(() => { const p = this.preview(); return p ? displayName(p) : ''; });
  protected readonly source = computed(() => { const p = this.preview(); return p ? sourceLabel(p.source) : ''; });
  protected readonly missing = signal(false);
  protected readonly events = signal<PreviewEvent[]>([]);
  protected readonly builds = signal<Build[]>([]);

  protected readonly canDestroy = computed(() => this.#auth.can('previews.destroy'));
  protected readonly canReadLogs = computed(() => this.#auth.can('logs.read'));

  constructor() {
    this.#store.connect();
    inject(DestroyRef).onDestroy(() => this.#store.disconnect());

    // A deep link, or a reload. WAIT for the list first: it usually holds this preview, and
    // asking for it separately as well would be a wasted request on every page load. Only
    // what the list does not have -- a destroyed preview, which it omits -- is fetched alone.
    effect(() => {
      const id = this.id();
      if (this.#store.loading() || this.#store.byId(id)()) return;
      untracked(() => {
        this.missing.set(false);
        void this.#store.load(id).then((p) => this.missing.set(p === undefined && !this.#store.byId(id)()));
      });
    });

    // History and builds are not on the event stream; refetch them when the preview moves.
    effect(() => {
      const p = this.preview();
      if (!p) return;
      void p.updatedAt;
      untracked(() => void this.#refreshHistory(p.id));
    });
  }

  async #refreshHistory(id: string): Promise<void> {
    const get = <T>(path: string, key: string) => firstValueFrom(this.#http.get<Record<string, T[]>>(`/v1/previews/${id}/${path}`)).then((r) => r[key] ?? []).catch(() => [] as T[]);
    const [events, builds] = await Promise.all([
      this.#auth.can('events.read') ? get<PreviewEvent>('events', 'events') : Promise.resolve([]),
      get<Build>('builds', 'builds'),
    ]);
    if (this.id() !== id) return;
    this.events.set([...events].reverse()); // newest first: what just happened is what you came for
    this.builds.set(builds);
  }

  protected async copy(url: string): Promise<void> {
    try { await navigator.clipboard.writeText(url); this.#toasts.info('Copied', url); }
    catch { this.#toasts.info('Could not copy', 'Select the URL and copy it by hand.'); }
  }

  protected async destroy(): Promise<void> {
    try {
      await this.#store.destroy(this.id());
    } catch (e) {
      this.#toasts.problem(`Could not destroy ${this.name()}`, e as ProblemError);
      if ((e as ProblemError).status === 403) void this.#auth.refresh();
    }
  }
}
