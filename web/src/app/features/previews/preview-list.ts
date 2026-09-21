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
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { StateBadge } from '../../ui/state-badge';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';
import { displayName, primaryUrl, sourceLabel } from './source-label';

/** Chips group the two "not ready yet" states: nobody filters for `starting` on its own. */
const STATE_CHIPS: { key: string; label: string; states: PreviewState[] }[] = [
  { key: 'awake', label: 'awake', states: ['awake'] },
  { key: 'asleep', label: 'asleep', states: ['asleep'] },
  { key: 'building', label: 'building', states: ['building', 'starting'] },
  { key: 'failed', label: 'failed', states: ['failed'] },
];
const SOURCE_KINDS: SourceKind[] = ['pr', 'git', 'image', 'tarball', 'agent', 'manual'];

@Component({
  selector: 'app-preview-list',
  imports: [RouterLink, Btn, ConfirmDialog, ConnectionDot, EmptyState, RelativeTimePipe, StateBadge],
  template: `
    <section class="mx-auto max-w-5xl px-6 py-10">
      <div class="flex items-baseline gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">Previews</h1>
        <span class="text-sm text-neutral-500" data-testid="count">{{ shown().length }}@if (filtered()) { of {{ store.previews().length }} }</span>
        <span class="ml-auto"><app-connection-dot [status]="store.status()" /></span>
      </div>

      <div class="mt-6 flex flex-wrap items-center gap-2">
        @for (chip of chips; track chip.key) {
          <button type="button" (click)="toggleState(chip.key)" [attr.aria-pressed]="states().has(chip.key)"
                  class="rounded-full border px-3 py-1 text-sm transition"
                  [class]="states().has(chip.key) ? 'border-accent bg-accent/10 text-accent' : 'border-neutral-300 text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400'"
                  [attr.data-testid]="'chip-' + chip.key">{{ chip.label }}</button>
        }
        <select aria-label="Source" [value]="source()" (change)="setSource($any($event.target).value)" data-testid="source"
                class="rounded-full border border-neutral-300 bg-transparent px-3 py-1 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
          <option value="">any source</option>
          @for (k of sourceKinds; track k) { <option [value]="k">{{ k }}</option> }
        </select>
        <input type="search" placeholder="Search name or repo" aria-label="Search" [value]="query()" (input)="setQuery($any($event.target).value)" data-testid="search"
               class="min-w-48 flex-1 rounded-full border border-neutral-300 bg-transparent px-3.5 py-1 text-sm placeholder:text-neutral-400 dark:border-neutral-700" />
        <label class="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          <input type="checkbox" [checked]="store.includeDestroyed()" (change)="setDestroyed($any($event.target).checked)" data-testid="show-destroyed" /> destroyed
        </label>
      </div>

      @if (store.error(); as e) {
        <p class="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300" role="alert" data-testid="list-error">
          Could not load previews: {{ e.detail }}@if (e.requestId) { <span class="font-mono text-xs opacity-70"> (request {{ e.requestId }})</span> }
        </p>
      }

      <div class="mt-6">
        @if (shown().length > 0) {
          <div class="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table class="w-full text-left text-sm">
              <thead class="border-b border-neutral-200 bg-neutral-50 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/50">
                <tr>
                  <th scope="col" class="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" class="px-4 py-2.5 font-medium">State</th>
                  <th scope="col" class="px-4 py-2.5 font-medium">Source</th>
                  <th scope="col" class="px-4 py-2.5 font-medium">Expires</th>
                  <th scope="col" class="px-4 py-2.5 font-medium">Created</th>
                  <th scope="col" class="px-4 py-2.5"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
                @for (p of shown(); track p.id) {
                  <tr [class.opacity-50]="p.state === 'destroyed'" data-testid="row" [attr.data-id]="p.id">
                    <td class="px-4 py-3">
                      <a [routerLink]="['/previews', p.id]" class="font-medium hover:text-accent" data-testid="name">{{ name(p) }}</a>
                      @if (url(p); as u) {
                        <a [href]="u" target="_blank" rel="noopener noreferrer" class="mt-0.5 block max-w-xs truncate font-mono text-xs text-neutral-500 hover:text-accent" data-testid="url">{{ host(u) }} ↗</a>
                      }
                    </td>
                    <td class="px-4 py-3"><app-state-badge [state]="p.state" /></td>
                    <td class="max-w-56 truncate px-4 py-3 text-neutral-600 dark:text-neutral-400" [title]="label(p)">
                      <span class="mr-1.5 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">{{ p.source.kind }}</span>{{ label(p) }}
                    </td>
                    <td class="px-4 py-3 whitespace-nowrap text-neutral-600 dark:text-neutral-400" [title]="p.ttlExpiresAt ?? ''">{{ p.ttlExpiresAt ? (p.ttlExpiresAt | relativeTime: clock.now()) : 'never' }}</td>
                    <td class="px-4 py-3 whitespace-nowrap text-neutral-600 dark:text-neutral-400" [title]="p.createdAt">{{ p.createdAt | relativeTime: clock.now() }}</td>
                    <td class="px-4 py-3 text-right">
                      @if (canDestroy() && destroyable(p)) {
                        <button type="button" (click)="ask(p)" class="text-sm text-neutral-500 hover:text-red-600 dark:hover:text-red-400" data-testid="destroy">Destroy</button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (store.loading() && store.previews().length === 0) {
          <p class="py-14 text-center text-sm text-neutral-500" data-testid="loading">Loading…</p>
        } @else if (filtered()) {
          <app-empty-state heading="Nothing matches these filters">
            <button appBtn variant="ghost" type="button" class="mt-3" (click)="clearFilters()" data-testid="clear">Clear filters</button>
          </app-empty-state>
        } @else if (!store.error()) {
          <app-empty-state heading="No previews yet">
            <p>Deploy one from the API and it will appear here as it happens — no refresh needed.</p>
            <pre class="mt-4 overflow-x-auto rounded-md bg-neutral-100 p-3 text-left font-mono text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300" data-testid="curl">{{ curl }}</pre>
          </app-empty-state>
        }
      </div>
    </section>

    <app-confirm-dialog [heading]="'Destroy ' + (pending() ? name(pending()!) : '') + '?'" confirmLabel="Destroy" (confirmed)="destroy()">
      Its containers, volumes and network are removed, its URL stops working, and its logs are deleted. This cannot be undone.
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
  // `viewChild` cannot sit on an ES #private member (NG1053), hence TypeScript `private`.
  private readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly chips = STATE_CHIPS;
  protected readonly sourceKinds = SOURCE_KINDS;
  protected readonly name = displayName;
  protected readonly url = primaryUrl;
  protected readonly label = (p: Preview) => sourceLabel(p.source);
  protected readonly host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
  /** The API answers on this origin too, so the hint is copy-pasteable as it stands. */
  protected readonly curl = [
    `curl -X POST ${typeof location === 'undefined' ? '' : location.origin}/v1/previews \\`,
    `  -H "Authorization: Bearer $GANGWAY_TOKEN" -H 'content-type: application/json' \\`,
    `  -d '{"name":"hello","source":{"kind":"image","image":"traefik/whoami:v1.10","port":80}}'`,
  ].join('\n');

  protected readonly states = signal<ReadonlySet<string>>(new Set());
  protected readonly source = signal('');
  protected readonly query = signal('');
  protected readonly pending = signal<Preview | null>(null);

  /** Advice about what to SHOW. The server refuses a DELETE the role does not allow, whatever this says. */
  protected readonly canDestroy = computed(() => this.#auth.can('previews.destroy'));
  protected readonly filtered = computed(() => this.states().size > 0 || this.source() !== '' || this.query().trim() !== '');

  protected readonly shown = computed(() => {
    const wanted = new Set(STATE_CHIPS.filter((c) => this.states().has(c.key)).flatMap((c) => c.states));
    const source = this.source();
    const q = this.query().trim().toLowerCase();
    return this.store.previews().filter((p) =>
      // `destroyed` rows are governed by their own checkbox, not by the state chips.
      (wanted.size === 0 || p.state === 'destroyed' || p.state === 'destroying' || wanted.has(p.state)) &&
      (source === '' || p.source.kind === source) &&
      (q === '' || displayName(p).toLowerCase().includes(q) || sourceLabel(p.source).toLowerCase().includes(q)));
  });

  constructor() {
    const q = this.#route.snapshot.queryParamMap;
    this.states.set(new Set((q.get('state') ?? '').split(',').filter((k) => STATE_CHIPS.some((c) => c.key === k))));
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
  protected setSource(v: string): void { this.source.set(v); this.#syncUrl(); }
  protected setQuery(v: string): void { this.query.set(v); this.#syncUrl(); }
  protected setDestroyed(on: boolean): void { void this.store.setIncludeDestroyed(on); this.#syncUrl(on); }
  protected clearFilters(): void { this.states.set(new Set()); this.source.set(''); this.query.set(''); this.#syncUrl(); }

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
      // A 403 here means the operator changed what this role may do, under an open tab.
      if ((e as ProblemError).status === 403) void this.#auth.refresh();
    }
  }

  /** Filters live in the URL so a filtered view can be bookmarked, shared, and survives a reload. */
  #syncUrl(destroyed = this.store.includeDestroyed()): void {
    void this.#router.navigate([], {
      relativeTo: this.#route, replaceUrl: true,
      queryParams: {
        state: this.states().size ? [...this.states()].join(',') : null,
        source: this.source() || null,
        q: this.query().trim() || null,
        destroyed: destroyed ? '1' : null,
      },
    });
  }
}
