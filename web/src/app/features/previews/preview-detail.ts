import { HttpClient } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { Build, PreviewEvent } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ClipboardService } from '../../ui/clipboard';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { EmptyState } from '../../ui/empty-state';
import { ErrorAlert } from '../../ui/error-alert';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { PasswordBadge } from '../../ui/password-badge';
import { StateBadge } from '../../ui/state-badge';
import { ToastService } from '../../ui/toast';
import { DbBrowser } from './db-browser';
import { LogViewer } from './log-viewer';
import { PasswordPanel } from './password-panel';
import { PreviewsStore } from './previews.store';
import { PreviewTitle } from './preview-title';
import { SourcePanel } from './source-panel';
import { displayName, sourceLabel } from './source-label';

@Component({
  selector: 'app-preview-detail',
  imports: [
    RouterLink,
    Btn,
    ConfirmDialog,
    DbBrowser,
    EmptyState,
    ErrorAlert,
    LogViewer,
    PasswordBadge,
    PasswordPanel,
    PreviewTitle,
    RelativeTimePipe,
    SourcePanel,
    StateBadge,
  ],
  template: `
    <section class="gw-page gap-9">
      <div class="flex flex-col gap-3.5">
        <a routerLink="/previews" class="gw-back">← Previews</a>

        @if (preview(); as p) {
          <div class="flex flex-wrap items-end gap-5 border-b border-ink pb-5">
            <app-preview-title [preview]="p" />
            <div class="flex flex-wrap items-center gap-3 pb-1.5">
              <app-state-badge [state]="p.state" />
              <span class="gw-tag" data-testid="visibility">{{ p.visibility }}</span>
              @if (p.state !== 'destroyed') {
                <app-password-badge [access]="p.access" />
              }
            </div>
            @if (canDestroy() && p.state !== 'destroying' && p.state !== 'destroyed') {
              <button
                appBtn
                variant="danger"
                type="button"
                class="mb-1 ml-auto"
                (click)="dialog().open()"
                data-testid="destroy"
              >
                Destroy
              </button>
            }
          </div>
        }
      </div>

      @if (preview(); as p) {
        @if (p.state === 'failed' && p.error) {
          <app-error-alert class="px-4 py-3" data-testid="failure">
            <p class="font-medium">This preview failed.</p>
            <p class="mt-1 font-mono text-xs break-words whitespace-pre-wrap">{{ p.error }}</p>
          </app-error-alert>
        }

        <div class="grid gap-12 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div class="flex flex-col gap-2.5">
            <h2 class="gw-label">URLs</h2>
            <ul class="border-t border-rule">
              @for (u of p.urls; track u.url) {
                <li class="flex items-center gap-4 border-b border-rule py-3" data-testid="url-row">
                  <span class="w-32 shrink-0 truncate text-[15px] font-medium"
                    >{{ u.service }}
                    @if (u.primary) {
                      <span
                        class="ml-1 text-[10px] font-semibold tracking-[.12em] text-muted uppercase"
                        >primary</span
                      >
                    }
                  </span>
                  <a
                    [href]="u.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="min-w-0 flex-1 truncate font-mono text-[13px] hover:underline"
                    >{{ u.url }}</a
                  >
                  <button type="button" (click)="copy(u.url)" class="gw-action" data-testid="copy">
                    Copy
                  </button>
                </li>
              } @empty {
                <li class="border-b border-rule py-3 text-sm text-muted">No routes.</li>
              }
            </ul>
          </div>

          <div class="flex flex-col gap-2.5">
            <h2 class="gw-label">Particulars</h2>
            <dl class="m-0 flex flex-col gap-[9px] text-[15px]" data-testid="facts">
              <div class="gw-fact">
                <dt>Source</dt>
                <dd>{{ p.source.kind }} · {{ source() }}</dd>
              </div>
              @if (p.state === 'destroyed') {
                <!-- "Expires in 59 min" under something already gone reads as if it were still there. -->
                <div class="gw-fact">
                  <dt>Destroyed</dt>
                  <dd [title]="p.destroyedAt ?? ''" data-testid="ttl">
                    {{ p.destroyedAt ? (p.destroyedAt | relativeTime: clock.now()) : 'yes' }}
                  </dd>
                </div>
              } @else {
                @if (p.secretLevel) {
                  <div class="gw-fact">
                    <dt>Secrets</dt>
                    <dd data-testid="secret-level">
                      {{ p.secretLevel }}{{ p.secretLevel === 'none' ? ' (no .env)' : '' }}
                    </dd>
                  </div>
                }
                @if (p.templateId) {
                  <div class="gw-fact">
                    <dt>Template</dt>
                    <dd>
                      <a
                        routerLink="/templates"
                        class="underline underline-offset-2"
                        data-testid="template"
                        >{{ p.templateId }}</a
                      >
                    </dd>
                  </div>
                }
                <div class="gw-fact">
                  <dt>Expires</dt>
                  <dd [title]="p.ttlExpiresAt ?? ''" data-testid="ttl">
                    {{ p.ttlExpiresAt ? (p.ttlExpiresAt | relativeTime: clock.now()) : 'never' }}
                  </dd>
                </div>
              }
              <div class="gw-fact">
                <dt>Created</dt>
                <dd [title]="p.createdAt">
                  {{ p.createdAt | relativeTime: clock.now() }}
                </dd>
              </div>
              <div class="gw-fact">
                <dt>Last visited</dt>
                <dd [title]="p.lastSeenAt ?? ''">
                  {{ p.lastSeenAt ? (p.lastSeenAt | relativeTime: clock.now()) : 'not yet' }}
                </dd>
              </div>
              <div class="gw-fact">
                <dt>Host</dt>
                <dd>{{ p.hostId }}</dd>
              </div>
            </dl>
          </div>
        </div>

        @if (p.state !== 'destroyed' && p.state !== 'destroying') {
          <app-password-panel [preview]="p" />
          <app-source-panel [previewId]="p.id" [uploaded]="p.source.kind === 'tarball'" />
        }

        @if (
          p.source.kind === 'tarball' &&
          p.source.addons?.length &&
          p.state !== 'destroyed' &&
          p.state !== 'destroying'
        ) {
          <div class="flex flex-col gap-2.5">
            <h2 class="gw-label">Databases</h2>
            <div class="h-[28rem] overflow-hidden border border-rule" data-testid="databases">
              <app-db-browser [previewId]="p.id" />
            </div>
          </div>
        }

        @if (canReadLogs()) {
          <div class="flex flex-col gap-2.5">
            <h2 class="gw-label">Logs</h2>
            @if (p.state === 'destroyed') {
              <p
                class="border border-dashed border-rule px-4 py-6 text-center text-sm text-muted"
                data-testid="logs-gone"
              >
                Logs are deleted when a preview is destroyed.
              </p>
            } @else {
              <app-log-viewer [previewId]="p.id" />
            }
          </div>
        }

        @if (builds().length > 0 || events().length > 0) {
          <div class="grid gap-12 md:grid-cols-2">
            @if (builds().length > 0) {
              <div class="flex flex-col gap-2.5">
                <h2 class="gw-label">
                  Builds
                  <span class="font-normal tracking-normal normal-case"
                    >— output is in the log above, on the
                    <code class="font-mono text-xs">build</code> stream</span
                  >
                </h2>
                <ul class="flex flex-col gap-2.5 text-[15px]" data-testid="builds">
                  @for (b of builds(); track b.id) {
                    <li class="flex gap-3 whitespace-nowrap">
                      <span class="w-20" [class.text-danger]="b.state === 'failed'">{{
                        b.state
                      }}</span>
                      <span class="text-muted">{{ b.service ?? 'all services' }}</span
                      ><span class="ml-auto text-muted" [title]="b.startedAt">{{
                        b.startedAt | relativeTime: clock.now()
                      }}</span>
                    </li>
                  }
                </ul>
              </div>
            }

            @if (events().length > 0) {
              <div class="flex flex-col gap-2.5">
                <h2 class="gw-label">History</h2>
                <ol class="flex flex-col gap-2.5 text-[15px]" data-testid="events">
                  @for (e of events(); track e.seq) {
                    <li class="flex gap-3">
                      <span class="w-24 shrink-0 whitespace-nowrap text-muted" [title]="e.at">{{
                        e.at | relativeTime: clock.now()
                      }}</span>
                      <span class="whitespace-nowrap">
                        @if (e.type === 'preview.state') {
                          {{ e.from }} → <i class="font-serif">{{ e.state }}</i>
                        } @else {
                          {{ e.type.replace('preview.', '') }}
                        }
                      </span>
                      @if (e.error) {
                        <span class="min-w-0 truncate text-danger" [title]="e.error">{{
                          e.error
                        }}</span>
                      }
                    </li>
                  }
                </ol>
              </div>
            }
          </div>
        }

        <app-confirm-dialog
          [heading]="'Destroy ' + name() + '?'"
          confirmLabel="Destroy"
          (confirmed)="destroy()"
        >
          Its containers, volumes and network are removed, its URL stops working, and its logs are
          deleted. This cannot be undone.
        </app-confirm-dialog>
      } @else if (missing()) {
        <app-empty-state heading="No such preview">
          It may have been destroyed — destroyed previews are kept only briefly.
          <a routerLink="/previews" class="text-ink underline underline-offset-2"
            >Back to the list</a
          >.
        </app-empty-state>
      } @else {
        <p class="text-sm text-muted" data-testid="loading">Loading…</p>
      }
    </section>
  `,
})
export class PreviewDetail {
  readonly id = input.required<string>();

  protected readonly clock = inject(Clock);
  readonly #store = inject(PreviewsStore);
  readonly #auth = inject(AuthService);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #clipboard = inject(ClipboardService);
  protected readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly preview = computed(() => this.#store.byId(this.id())());
  protected readonly name = computed(() => {
    const p = this.preview();
    return p ? displayName(p) : '';
  });
  protected readonly source = computed(() => {
    const p = this.preview();
    return p ? sourceLabel(p.source) : '';
  });
  protected readonly missing = signal(false);
  protected readonly events = signal<PreviewEvent[]>([]);
  protected readonly builds = signal<Build[]>([]);

  protected readonly canDestroy = computed(() => this.#auth.can('previews.destroy'));
  protected readonly canReadLogs = computed(() => this.#auth.can('logs.read'));

  constructor() {
    this.#store.connect();
    inject(DestroyRef).onDestroy(() => this.#store.disconnect());

    effect(() => {
      const id = this.id();
      if (this.#store.loading() || this.#store.byId(id)()) return;
      untracked(() => {
        this.missing.set(false);
        void this.#store
          .load(id)
          .then((p) => this.missing.set(p === undefined && !this.#store.byId(id)()));
      });
    });

    effect(() => {
      const p = this.preview();
      if (!p) return;
      void p.updatedAt;
      untracked(() => void this.#refreshHistory(p.id));
    });
  }

  async #refreshHistory(id: string): Promise<void> {
    const get = <T>(path: string, key: string) =>
      firstValueFrom(this.#http.get<Record<string, T[]>>(`/v1/previews/${id}/${path}`))
        .then((r) => r[key] ?? [])
        .catch(() => [] as T[]);
    const [events, builds] = await Promise.all([
      this.#auth.can('events.read') ? get<PreviewEvent>('events', 'events') : Promise.resolve([]),
      get<Build>('builds', 'builds'),
    ]);
    if (this.id() !== id) return;
    this.events.set([...events].reverse());
    this.builds.set(builds);
  }

  protected copy(url: string): Promise<void> {
    return this.#clipboard.copy(
      url,
      ['Copied', url],
      ['Could not copy', 'Select the URL and copy it by hand.'],
    );
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
