import { HttpClient, HttpParams } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AuditEntry, AuditPage, User } from '../../core/admin.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { Skeleton } from '../../ui/skeleton';
import { ToastService } from '../../ui/toast';

const PAGE = 50;

/** Every change anyone made, newest first, fifty at a time. */
@Component({
  selector: 'app-audit-log',
  imports: [Btn, RelativeTimePipe, Skeleton],
  host: { class: 'flex flex-col gap-5' },
  template: `
    <form class="flex flex-wrap items-end gap-3" (submit)="$event.preventDefault(); filter()">
      <label class="gw-label block min-w-64"
        >Action
        <input
          [class]="field + ' font-mono'"
          list="audit-actions"
          placeholder="All actions"
          spellcheck="false"
          [value]="action()"
          (input)="action.set($any($event.target).value)"
          data-testid="audit-action"
        />
        <datalist id="audit-actions">
          @for (a of seenActions(); track a) {
            <option [value]="a"></option>
          }
        </datalist>
      </label>
      <button appBtn variant="ghost" size="sm" type="submit" data-testid="audit-filter">
        Filter
      </button>
      @if (applied()) {
        <button
          type="button"
          class="gw-action"
          (click)="action.set(''); filter()"
          data-testid="audit-clear"
        >
          Show all
        </button>
      }
    </form>

    @if (loading() && entries().length === 0) {
      <app-skeleton kind="rows" [count]="6" />
    } @else {
      <div class="overflow-x-auto">
        <table class="w-full border-t border-ink text-sm" data-testid="audit">
          <thead>
            <tr class="border-b border-ink text-left">
              <th class="gw-label py-2 pr-4 font-semibold">When</th>
              <th class="gw-label py-2 pr-4 font-semibold">Who</th>
              <th class="gw-label py-2 pr-4 font-semibold">Action</th>
              <th class="gw-label py-2 pr-4 font-semibold">Target</th>
              <th class="gw-label py-2 font-semibold">Change</th>
            </tr>
          </thead>
          <tbody>
            @for (e of entries(); track e.seq) {
              <tr class="border-b border-rule align-top" data-testid="audit-entry">
                <td class="py-2 pr-4 whitespace-nowrap text-muted" [title]="e.createdAt">
                  {{ e.createdAt | relativeTime: clock.now() }}
                </td>
                <td class="py-2 pr-4 break-all" data-testid="audit-who">{{ who(e) }}</td>
                <td class="py-2 pr-4">
                  <button
                    type="button"
                    class="font-mono text-xs hover:underline"
                    title="Show only this action"
                    (click)="action.set(e.action); filter()"
                  >
                    {{ e.action }}
                  </button>
                </td>
                <td class="py-2 pr-4 font-mono text-xs break-all text-muted">
                  {{ targetName(e) }}
                </td>
                <td class="py-2 font-mono text-xs break-all text-muted">{{ change(e) }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="py-2.5 text-muted" data-testid="audit-empty">
                  Nothing recorded{{ applied() ? ' for ' + applied() : '' }}.
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (nextBefore() !== null) {
        <button
          appBtn
          variant="ghost"
          size="sm"
          type="button"
          class="self-start"
          [disabled]="loading()"
          (click)="more()"
          data-testid="audit-more"
        >
          {{ loading() ? 'Loading…' : 'Older' }}
        </button>
      }
    }
  `,
})
export class AuditLog {
  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #toasts = inject(ToastService);
  protected readonly clock = inject(Clock);
  protected readonly field = FIELD;

  protected readonly entries = signal<AuditEntry[]>([]);
  protected readonly nextBefore = signal<number | null>(null);
  protected readonly loading = signal(false);
  protected readonly action = signal('');
  protected readonly applied = signal('');
  readonly #emails = signal<ReadonlyMap<string, string>>(new Map());
  readonly #actions = signal<ReadonlySet<string>>(new Set());
  protected readonly seenActions = computed(() =>
    [...this.#actions()].sort((a, b) => Number(a > b) - Number(a < b)),
  );

  constructor() {
    void this.#page(); // NOSONAR the load starts with the component; moving it to ngOnInit changes its timing
    if (this.#auth.can('users.read')) void this.#loadEmails(); // NOSONAR the load starts with the component; moving it to ngOnInit changes its timing
  }

  async #loadEmails(): Promise<void> {
    try {
      const { users } = await firstValueFrom(this.#http.get<{ users: User[] }>('/v1/users'));
      this.#emails.set(new Map(users.map((u) => [u.id, u.email])));
    } catch {
      // Ids stand in for emails; the log is still readable.
    }
  }

  protected filter(): void {
    this.applied.set(this.action().trim());
    this.entries.set([]);
    this.nextBefore.set(null);
    void this.#page();
  }

  protected more(): void {
    void this.#page(this.nextBefore() ?? undefined);
  }

  async #page(before?: number): Promise<void> {
    this.loading.set(true);
    let params = new HttpParams().set('limit', PAGE);
    if (before !== undefined) params = params.set('before', before);
    if (this.applied()) params = params.set('action', this.applied());
    try {
      const page = await firstValueFrom(this.#http.get<AuditPage>('/v1/audit', { params }));
      this.entries.update((es) => [...es, ...page.entries]);
      this.nextBefore.set(page.nextBefore);
      this.#actions.update((s) => new Set([...s, ...page.entries.map((e) => e.action)]));
    } catch (e) {
      this.#toasts.problem('Could not load the audit log', toProblem(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected who(e: AuditEntry): string {
    if (e.actorType === 'system') return 'gangway';
    if (e.actorId === null) return e.actorType;
    if (e.actorType === 'user') return this.#emails().get(e.actorId) ?? e.actorId;
    if (e.actorType === 'token') {
      const kind = e.actorId.startsWith('oauth:') ? 'agent' : 'token';
      if (e.actorName) return `${e.actorName} (${kind})`;
      // An agent's grant id means nothing to a reader; a token id such as env:admin does.
      return kind === 'agent' ? 'agent' : `token ${e.actorId}`;
    }
    return `${e.actorType} ${e.actorId}`;
  }

  protected targetName(e: AuditEntry): string {
    if (e.target === null) return '';
    return this.#emails().get(e.target) ?? e.target;
  }

  protected change(e: AuditEntry): string {
    return [e.old, e.new]
      .map((v) => (v === null || v === undefined ? '' : JSON.stringify(v)))
      .filter(Boolean)
      .join(' → ');
  }
}
