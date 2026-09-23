import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AddonId,
  DataResult,
  DataTable,
  PreviewAddon,
  RedisKey,
  RedisKeys,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';

const PAGE = 50;

@Component({
  selector: 'app-db-browser',
  imports: [Btn],
  template: `
    @if (!canData()) {
      <p class="p-4 text-sm text-muted" data-testid="db-no-permission">
        Looking inside a preview's databases needs
        <code class="font-mono text-xs">previews.data</code>.
      </p>
    } @else if (addons().length === 0) {
      <p class="p-4 text-sm text-muted" data-testid="db-none">
        This preview has no databases. Add one with
        <code class="font-mono text-xs">addons: [postgres]</code> in gangway.yml, and save.
      </p>
    } @else {
      <div class="flex h-full min-h-0 flex-col text-sm">
        <div class="flex items-center gap-1 border-b border-rule bg-surface px-2 py-1.5">
          @for (a of addons(); track a.id) {
            <button
              type="button"
              (click)="pick(a.id)"
              [attr.aria-pressed]="addon() === a.id"
              [attr.data-testid]="'db-' + a.id"
              class="px-2.5 py-[3px] text-xs font-medium tracking-[.1em] uppercase"
              [class]="addon() === a.id ? 'bg-ink text-paper' : 'text-muted hover:text-ink'"
            >
              {{ a.name }} {{ a.version }}
            </button>
          }
          <label class="ml-auto flex items-center gap-1.5 text-xs text-muted"
            ><input
              type="checkbox"
              class="gw-box"
              [checked]="write()"
              (change)="write.set($any($event.target).checked)"
              data-testid="db-write"
            />
            allow writes</label
          >
        </div>

        <div class="grid min-h-0 flex-1 grid-cols-[12rem_1fr]">
          <div class="min-h-0 overflow-auto border-r border-rule" data-testid="db-list">
            @if (addon() === 'redis') {
              <form (submit)="$event.preventDefault(); loadKeys(true)" class="p-1.5">
                <input
                  class="w-full border-0 border-b border-ink bg-transparent px-0 py-1 font-mono text-xs placeholder:text-muted focus:outline-none focus-visible:shadow-[0_2px_0_var(--gw-flag)]"
                  placeholder="match *"
                  [value]="match()"
                  (input)="match.set($any($event.target).value)"
                  aria-label="Key pattern"
                  data-testid="db-match"
                />
              </form>
              @for (k of keys(); track k) {
                <button
                  type="button"
                  (click)="openKey(k)"
                  class="block w-full truncate px-2 py-0.5 text-left font-mono text-xs hover:bg-ink/5"
                  [class.font-semibold]="selected() === k"
                  data-testid="db-key"
                >
                  {{ k }}
                </button>
              }
              @if (cursor() !== '0') {
                <button
                  type="button"
                  (click)="loadKeys(false)"
                  class="gw-action px-2 py-1"
                  data-testid="db-more"
                >
                  more…
                </button>
              }
            } @else {
              @for (t of tables(); track t.schema + '.' + t.name) {
                <button
                  type="button"
                  (click)="openTable(t)"
                  class="block w-full truncate px-2 py-0.5 text-left font-mono text-xs hover:bg-ink/5"
                  [class.font-semibold]="selected() === t.schema + '.' + t.name"
                  data-testid="db-table"
                >
                  {{
                    t.schema === 'public' || t.schema === 'app' ? t.name : t.schema + '.' + t.name
                  }}
                </button>
              } @empty {
                <p class="p-2 text-xs text-muted">No tables yet.</p>
              }
            }
          </div>

          <div class="flex min-h-0 flex-col">
            <div class="flex items-start gap-2 border-b border-rule p-2">
              <textarea
                class="h-14 min-w-0 flex-1 resize-y border border-rule bg-surface px-2 py-1 font-mono text-xs text-ink placeholder:text-muted focus:border-ink focus:outline-none"
                [placeholder]="
                  addon() === 'redis' ? 'GET key   (⌘↵ to run)' : 'select * from …   (⌘↵ to run)'
                "
                [value]="text()"
                (input)="text.set($any($event.target).value)"
                (keydown)="key($event)"
                aria-label="Query"
                data-testid="db-text"
              ></textarea>
              <button
                appBtn
                size="sm"
                type="button"
                (click)="run()"
                [disabled]="busy() || !text().trim()"
                data-testid="db-run"
              >
                Run
              </button>
            </div>
            @if (error(); as e) {
              <p
                class="px-2 py-1 font-mono text-xs whitespace-pre-wrap text-danger"
                role="alert"
                data-testid="db-error"
              >
                {{ e }}
              </p>
            }
            @if (result(); as r) {
              <div
                class="flex items-center gap-3 px-2 py-1 text-xs text-muted"
                data-testid="db-meta"
              >
                <span
                  >{{ r.rows.length }} row{{ r.rows.length === 1 ? '' : 's'
                  }}{{ r.truncated ? ' (cut off)' : '' }} · {{ r.ms }} ms</span
                >
                @if (keyInfo(); as k) {
                  <span>{{ k }}</span>
                }
                @if (table()) {
                  <span class="ml-auto flex gap-2">
                    <button
                      type="button"
                      (click)="page(-1)"
                      [disabled]="offset() === 0"
                      class="disabled:opacity-40"
                      data-testid="db-prev"
                    >
                      ← prev
                    </button>
                    <span>{{ offset() + 1 }}–{{ offset() + r.rows.length }}</span>
                    <button
                      type="button"
                      (click)="page(1)"
                      [disabled]="r.rows.length < pageSize"
                      class="disabled:opacity-40"
                      data-testid="db-next"
                    >
                      next →
                    </button>
                  </span>
                }
              </div>
              <div class="min-h-0 flex-1 overflow-auto">
                <table class="min-w-full border-collapse font-mono text-xs" data-testid="db-grid">
                  <thead class="sticky top-0 bg-paper">
                    <tr>
                      @for (c of r.columns; track $index) {
                        <th class="border-b border-ink px-2 py-1 text-left font-medium">
                          {{ c }}
                        </th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of r.rows; track $index) {
                      <tr class="odd:bg-surface">
                        @for (cell of row; track $index) {
                          <td
                            class="max-w-80 truncate border-b border-rule/60 px-2 py-0.5"
                            [title]="cell ?? 'NULL'"
                          >
                            @if (cell === null) {
                              <span class="text-muted italic">NULL</span>
                            } @else {
                              {{ cell }}
                            }
                          </td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
                @if (r.message) {
                  <p class="px-2 py-1 text-xs text-muted">{{ r.message }}</p>
                }
              </div>
            } @else if (busy()) {
              <p class="p-2 text-xs text-muted">Running…</p>
            }
          </div>
        </div>
      </div>
    }
  `,
  host: { class: 'block h-full' },
})
export class DbBrowser {
  readonly previewId = input.required<string>();

  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  protected readonly pageSize = PAGE;

  protected readonly canData = computed(() => this.#auth.can('previews.data'));
  readonly addons = signal<PreviewAddon[]>([]);
  readonly addon = signal<AddonId | null>(null);
  readonly tables = signal<DataTable[]>([]);
  readonly keys = signal<string[]>([]);
  protected readonly cursor = signal('0');
  protected readonly match = signal('');
  protected readonly selected = signal<string | null>(null);
  protected readonly table = signal<DataTable | null>(null);
  protected readonly offset = signal(0);
  protected readonly keyInfo = signal<string | null>(null);
  readonly text = signal('');
  readonly write = signal(false);
  readonly result = signal<DataResult | null>(null);
  readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  #base = (): string => `/v1/previews/${this.previewId()}/addons`;

  constructor() {
    effect(() => {
      const id = this.previewId();
      if (!this.#auth.can('previews.read')) return;
      untracked(() => void this.#load(id));
    });
  }

  async #load(id: string): Promise<void> {
    const r = await firstValueFrom(
      this.#http.get<{ addons: PreviewAddon[] }>(`/v1/previews/${id}/addons`),
    ).catch(() => ({ addons: [] }));
    if (this.previewId() !== id) return;
    this.addons.set(r.addons);
    if (r.addons[0] && this.canData()) this.pick(r.addons[0].id);
  }

  pick(id: AddonId): void {
    this.addon.set(id);
    this.result.set(null);
    this.error.set(null);
    this.selected.set(null);
    this.table.set(null);
    this.keyInfo.set(null);
    if (id === 'redis') void this.loadKeys(true);
    else
      void this.#call(() =>
        firstValueFrom(
          this.#http.get<{ tables: DataTable[] }>(`${this.#base()}/${id}/tables`),
        ).then((r) => {
          this.tables.set(r.tables);
          return null;
        }),
      );
  }

  async loadKeys(fresh: boolean): Promise<void> {
    const cursor = fresh ? '0' : this.cursor();
    const params = { cursor, match: this.match() || '*' };
    await this.#call(async () => {
      const r = await firstValueFrom(
        this.#http.get<RedisKeys>(`${this.#base()}/redis/keys`, { params }),
      );
      this.keys.set(fresh ? r.keys : [...this.keys(), ...r.keys]);
      this.cursor.set(r.cursor);
      return null;
    });
  }

  async openKey(name: string): Promise<void> {
    this.selected.set(name);
    this.table.set(null);
    await this.#call(async () => {
      const r = await firstValueFrom(
        this.#http.get<RedisKey>(`${this.#base()}/redis/key`, { params: { name } }),
      );
      this.keyInfo.set(`${r.type}${r.ttl === '-1' ? '' : ` · ttl ${r.ttl}s`}`);
      return r.value;
    });
  }

  async openTable(t: DataTable, offset = 0): Promise<void> {
    const a = this.addon();
    if (!a) return;
    this.selected.set(`${t.schema}.${t.name}`);
    this.table.set(t);
    this.offset.set(offset);
    this.keyInfo.set(null);
    await this.#call(() =>
      firstValueFrom(
        this.#http.get<DataResult>(`${this.#base()}/${a}/rows`, {
          params: { schema: t.schema, table: t.name, limit: PAGE, offset },
        }),
      ),
    );
  }

  protected page(dir: 1 | -1): void {
    const t = this.table();
    if (t) void this.openTable(t, Math.max(0, this.offset() + dir * PAGE));
  }

  async run(): Promise<void> {
    const a = this.addon(),
      text = this.text().trim();
    if (!a || !text || this.busy()) return;
    this.table.set(null);
    this.keyInfo.set(null);
    await this.#call(() =>
      firstValueFrom(
        this.#http.post<DataResult>(`${this.#base()}/${a}/query`, { text, write: this.write() }),
      ),
    );
    if (this.write() && !this.error()) {
      if (a === 'redis') void this.loadKeys(true);
      else void this.#refreshTables(a);
    }
  }

  protected key(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void this.run();
    }
  }

  async #refreshTables(a: AddonId): Promise<void> {
    const r = await firstValueFrom(
      this.#http.get<{ tables: DataTable[] }>(`${this.#base()}/${a}/tables`),
    ).catch(() => null);
    if (r) this.tables.set(r.tables);
  }

  async #call(fn: () => Promise<DataResult | null>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await fn();
      if (r) this.result.set(r);
    } catch (e) {
      this.error.set(toProblem(e).detail);
      if (toProblem(e).status === 403) void this.#auth.refresh();
    } finally {
      this.busy.set(false);
    }
  }
}
