import { Component, DestroyRef, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Preview, PreviewState, SourceKind } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { ConnectionDot } from '../../ui/connection-dot';
import { EmptyState } from '../../ui/empty-state';
import { ErrorAlert } from '../../ui/error-alert';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { PasswordBadge } from '../../ui/password-badge';
import { StateBadge } from '../../ui/state-badge';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';
import { displayName, primaryUrl, slugOf, sourceLabel } from './source-label';

const STATE_CHIPS: { key: string; label: string; states: PreviewState[] }[] = [
  { key: 'awake', label: 'awake', states: ['awake'] },
  { key: 'asleep', label: 'asleep', states: ['asleep'] },
  { key: 'building', label: 'building', states: ['building', 'starting'] },
  { key: 'failed', label: 'failed', states: ['failed'] },
];
const SOURCE_KINDS: SourceKind[] = ['pr', 'git', 'image', 'tarball', 'agent', 'manual'];

@Component({
  selector: 'app-preview-list',
  imports: [
    RouterLink,
    Btn,
    ConfirmDialog,
    ConnectionDot,
    EmptyState,
    ErrorAlert,
    RelativeTimePipe,
    StateBadge,
    PasswordBadge,
  ],
  template: `
    <section class="gw-page">
      <div class="gw-title-rule flex flex-wrap items-end gap-3.5">
        <h1 class="gw-h1">Previews</h1>
        <span class="pb-1.5 font-mono text-[15px] text-muted" data-testid="count"
          >{{ shown().length }}
          @if (filtered()) {
            of {{ store.previews().length }}
          }
        </span>
        <span class="ml-auto pb-2.5"><app-connection-dot [status]="store.status()" /></span>
        @if (canDeploy()) {
          <a appBtn routerLink="/new" class="mb-1" data-testid="new">New preview</a>
        }
      </div>

      <div class="flex flex-wrap items-center gap-5">
        <div class="flex">
          @for (chip of chips; track chip.key; let first = $first) {
            <button
              type="button"
              (click)="toggleState(chip.key)"
              [attr.aria-pressed]="states().has(chip.key)"
              class="border px-3.5 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-flag"
              [class.border-l-0]="!first"
              [class]="
                states().has(chip.key)
                  ? 'border-ink bg-ink text-paper'
                  : 'border-rule hover:bg-ink/5'
              "
              [attr.data-testid]="'chip-' + chip.key"
            >
              {{ chip.label }}
            </button>
          }
        </div>
        <select
          aria-label="Source"
          [value]="source()"
          (change)="setSource($any($event.target).value)"
          data-testid="source"
          class="border-0 border-b border-ink bg-transparent py-1.5 pr-6 text-sm focus:outline-none focus-visible:shadow-[0_2px_0_var(--gw-flag)] [&>option]:bg-paper"
        >
          <option value="">any source</option>
          @for (k of sourceKinds; track k) {
            <option [value]="k">{{ k }}</option>
          }
        </select>
        <input
          type="search"
          placeholder="Search name or repo"
          aria-label="Search"
          [value]="query()"
          (input)="setQuery($any($event.target).value)"
          data-testid="search"
          class="min-w-48 flex-1 border-0 border-b border-ink bg-transparent py-1.5 text-sm placeholder:text-muted focus:outline-none focus-visible:shadow-[0_2px_0_var(--gw-flag)]"
        />
        <label class="flex items-center gap-1.5 text-sm text-muted">
          <input
            type="checkbox"
            class="gw-box"
            [checked]="store.includeDestroyed()"
            (change)="setDestroyed($any($event.target).checked)"
            data-testid="show-destroyed"
          />
          destroyed
        </label>
      </div>

      @if (store.error(); as e) {
        <app-error-alert
          class="px-3 py-2.5"
          [problem]="e"
          lead="Could not load previews: "
          data-testid="list-error"
        />
      }

      <div>
        @if (shown().length > 0) {
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="gw-label border-b border-ink">
                <tr>
                  <th scope="col" class="py-2 pr-4 font-semibold">Name</th>
                  <th scope="col" class="py-2 pr-4 font-semibold">State</th>
                  <th scope="col" class="py-2 pr-4 font-semibold">Source</th>
                  <th scope="col" class="py-2 pr-4 font-semibold">Expires</th>
                  <th scope="col" class="py-2 pr-4 font-semibold">Created</th>
                  <th scope="col" class="py-2"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (p of shown(); track p.id) {
                  <tr
                    class="border-b border-rule"
                    [class.opacity-50]="p.state === 'destroyed'"
                    data-testid="row"
                    [attr.data-id]="p.id"
                  >
                    <td class="py-3 pr-4">
                      <span class="flex items-center gap-2">
                        <a
                          [routerLink]="['/previews', p.id]"
                          class="font-serif text-[19px] hover:underline"
                          data-testid="name"
                          >{{ name(p) }}</a
                        >
                        @if (p.state !== 'destroyed') {
                          <app-password-badge [access]="p.access" />
                        }
                      </span>
                      @if (url(p); as u) {
                        <a
                          [href]="u"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="mt-0.5 block max-w-xs truncate font-mono text-xs text-muted hover:text-ink hover:underline"
                          data-testid="url"
                          >{{ host(u) }} ↗</a
                        >
                      }
                    </td>
                    <td class="py-3 pr-4 whitespace-nowrap">
                      <app-state-badge [state]="p.state" />
                    </td>
                    <td class="max-w-64 truncate py-3 pr-4" [title]="label(p)">
                      <span class="gw-chip mr-2">{{ p.source.kind }}</span
                      >{{ label(p) }}
                    </td>
                    <td
                      class="py-3 pr-4 whitespace-nowrap text-muted"
                      [title]="p.ttlExpiresAt ?? ''"
                      data-testid="expires"
                    >
                      {{
                        p.state === 'destroyed'
                          ? '—'
                          : p.ttlExpiresAt
                            ? (p.ttlExpiresAt | relativeTime: clock.now())
                            : 'never'
                      }}
                    </td>
                    <td class="py-3 pr-4 whitespace-nowrap text-muted" [title]="p.createdAt">
                      {{ p.createdAt | relativeTime: clock.now() }}
                    </td>
                    <td class="py-3 text-right">
                      @if (canDestroy() && destroyable(p)) {
                        <button
                          type="button"
                          (click)="ask(p)"
                          class="gw-action hover:!text-danger"
                          data-testid="destroy"
                        >
                          Destroy
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (store.loading() && store.previews().length === 0) {
          <p class="py-14 text-center text-sm text-muted" data-testid="loading">Loading…</p>
        } @else if (filtered()) {
          <app-empty-state heading="Nothing matches these filters">
            <button
              appBtn
              variant="ghost"
              type="button"
              class="mt-3"
              (click)="clearFilters()"
              data-testid="clear"
            >
              Clear filters
            </button>
          </app-empty-state>
        } @else if (!store.error()) {
          <app-empty-state heading="No previews yet">
            @if (canDeploy()) {
              <p>
                <a
                  routerLink="/new"
                  class="text-ink underline underline-offset-2"
                  data-testid="empty-new"
                  >Create one</a
                >
                from a runtime's starter or by dropping in files — or deploy from the API. It will
                appear here as it happens, no refresh needed.
              </p>
            } @else {
              <p>
                Deploy one from the API and it will appear here as it happens — no refresh needed.
              </p>
            }
            <pre
              class="mt-4 overflow-x-auto bg-log p-3 text-left font-mono text-xs text-log-fg"
              data-testid="curl"
              >{{ curl }}</pre>
          </app-empty-state>
        }
      </div>
    </section>

    <app-confirm-dialog
      [heading]="'Destroy ' + (pending() ? name(pending()!) : '') + '?'"
      confirmLabel="Destroy"
      (confirmed)="destroy()"
    >
      Its containers, volumes and network are removed, its URL stops working, and its logs are
      deleted. This cannot be undone.
    </app-confirm-dialog>
  `,
})
export class PreviewList {
  protected readonly store = inject(PreviewsStore);
  protected readonly clock = inject(Clock);
  readonly #auth = inject(AuthService);
  readonly #toasts = inject(ToastService);
  readonly #router = inject(Router);
  readonly #route = inject(ActivatedRoute);
  // viewChild cannot target an ES #private field (NG1053).
  private readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly chips = STATE_CHIPS;
  protected readonly sourceKinds = SOURCE_KINDS;
  protected readonly name = displayName;
  protected readonly url = primaryUrl;
  protected readonly label = (p: Preview) => sourceLabel(p.source);
  protected readonly host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  protected readonly curl = [
    `curl -X POST ${typeof location === 'undefined' ? '' : location.origin}/v1/previews \\`,
    `  -H "Authorization: Bearer $GANGWAY_TOKEN" -H 'content-type: application/json' \\`,
    `  -d '{"name":"hello","source":{"kind":"image","image":"traefik/whoami:v1.10","port":80}}'`,
  ].join('\n');

  protected readonly states = signal<ReadonlySet<string>>(new Set());
  protected readonly source = signal('');
  protected readonly query = signal('');
  protected readonly pending = signal<Preview | null>(null);

  protected readonly canDestroy = computed(() => this.#auth.can('previews.destroy'));
  protected readonly canDeploy = computed(() => this.#auth.can('previews.deploy'));
  protected readonly filtered = computed(
    () => this.states().size > 0 || this.source() !== '' || this.query().trim() !== '',
  );

  protected readonly shown = computed(() => {
    const wanted = new Set(
      STATE_CHIPS.filter((c) => this.states().has(c.key)).flatMap((c) => c.states),
    );
    const source = this.source();
    const q = this.query().trim().toLowerCase();
    return this.store.previews().filter(
      (p) =>
        // Destroyed rows follow their own checkbox, not the state chips.
        (wanted.size === 0 ||
          p.state === 'destroyed' ||
          p.state === 'destroying' ||
          wanted.has(p.state)) &&
        (source === '' || p.source.kind === source) &&
        (q === '' ||
          displayName(p).toLowerCase().includes(q) ||
          slugOf(p).toLowerCase().includes(q) ||
          sourceLabel(p.source).toLowerCase().includes(q)),
    );
  });

  constructor() {
    const q = this.#route.snapshot.queryParamMap;
    this.states.set(
      new Set(
        (q.get('state') ?? '').split(',').filter((k) => STATE_CHIPS.some((c) => c.key === k)),
      ),
    );
    this.source.set(SOURCE_KINDS.includes(q.get('source') as SourceKind) ? q.get('source')! : '');
    this.query.set(q.get('q') ?? '');
    if (q.get('destroyed') === '1') this.store.includeDestroyed.set(true);

    this.store.connect();
    inject(DestroyRef).onDestroy(() => this.store.disconnect());
  }

  protected destroyable(p: Preview): boolean {
    return p.state !== 'destroying' && p.state !== 'destroyed';
  }

  protected toggleState(key: string): void {
    const next = new Set(this.states());
    if (!next.delete(key)) next.add(key);
    this.states.set(next);
    this.#syncUrl();
  }
  protected setSource(v: string): void {
    this.source.set(v);
    this.#syncUrl();
  }
  protected setQuery(v: string): void {
    this.query.set(v);
    this.#syncUrl();
  }
  protected setDestroyed(on: boolean): void {
    void this.store.setIncludeDestroyed(on);
    this.#syncUrl(on);
  }
  protected clearFilters(): void {
    this.states.set(new Set());
    this.source.set('');
    this.query.set('');
    this.#syncUrl();
  }

  protected ask(p: Preview): void {
    this.pending.set(p);
    this.dialog().open();
  }

  protected async destroy(): Promise<void> {
    const p = this.pending();
    if (!p) return;
    try {
      await this.store.destroy(p.id);
    } catch (e) {
      this.#toasts.problem(`Could not destroy ${displayName(p)}`, e as ProblemError);
      if ((e as ProblemError).status === 403) void this.#auth.refresh();
    }
  }

  #syncUrl(destroyed = this.store.includeDestroyed()): void {
    void this.#router.navigate([], {
      relativeTo: this.#route,
      replaceUrl: true,
      queryParams: {
        state: this.states().size ? [...this.states()].join(',') : null,
        source: this.source() || null,
        q: this.query().trim() || null,
        destroyed: destroyed ? '1' : null,
      },
    });
  }
}
