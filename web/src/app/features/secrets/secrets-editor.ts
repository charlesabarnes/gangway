import { HttpClient } from '@angular/common/http';
import { Component, inject, input, linkedSignal, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SECRET_LEVELS, type SecretLevel, type SecretListing } from '../../core/api.types';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';

const LEVEL_CLASS: Record<SecretLevel, string> = {
  low: 'border-emerald-400 text-emerald-700 dark:text-emerald-300',
  standard: 'border-neutral-300 dark:border-neutral-700',
  high: 'border-red-400 text-red-700 dark:text-red-300',
};

@Component({
  selector: 'app-secrets-editor',
  imports: [Btn],
  template: `
    <ul class="mt-2 flex flex-wrap gap-2">
      @for (s of secrets(); track s.name) {
        <li
          class="flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-xs"
          [class]="levelClass[s.level]"
          data-testid="secret"
        >
          {{ s.name }}<span class="text-neutral-400">=••••</span>
          <select
            class="ml-1 bg-transparent text-[11px]"
            (change)="relevel(s.name, $any($event.target).value)"
            [attr.aria-label]="'Level of ' + s.name"
            data-testid="level"
          >
            @for (l of levels; track l) {
              <option [value]="l" [selected]="l === s.level">{{ l }}</option>
            }
          </select>
          <button
            type="button"
            (click)="unset(s.name)"
            class="ml-1 text-neutral-500 hover:text-red-600"
            [attr.aria-label]="'Remove ' + s.name"
            data-testid="unset"
          >
            ×
          </button>
        </li>
      } @empty {
        <li class="text-xs text-neutral-500" data-testid="no-secrets">None yet.</li>
      }
    </ul>
    <form (submit)="set($event)" novalidate class="mt-2 flex flex-wrap items-end gap-2">
      <label class="text-xs text-neutral-500"
        >Name<input
          [class]="field"
          placeholder="FONTAWESOME_TOKEN"
          autocomplete="off"
          [value]="draft().name"
          (input)="edit('name', $any($event.target).value)"
          data-testid="secret-name"
      /></label>
      <label class="min-w-64 flex-1 text-xs text-neutral-500"
        >Value<input
          [class]="field"
          type="password"
          autocomplete="new-password"
          [value]="draft().value"
          (input)="edit('value', $any($event.target).value)"
          data-testid="secret-value"
      /></label>
      <label class="text-xs text-neutral-500"
        >Level<select
          [class]="field"
          (change)="edit('level', $any($event.target).value)"
          data-testid="secret-level"
        >
          @for (l of levels; track l) {
            <option [value]="l" [selected]="l === draft().level">{{ l }}</option>
          }
        </select></label
      >
      <button appBtn variant="ghost" type="submit" [disabled]="!ready()" data-testid="set-secret">
        Set
      </button>
    </form>
    <details class="mt-2">
      <summary class="cursor-pointer text-xs text-neutral-500">Paste a .env instead</summary>
      <form (submit)="paste($event)" novalidate class="mt-2">
        <textarea
          [class]="field"
          rows="5"
          spellcheck="false"
          placeholder='KEY=value&#10;OTHER="quoted value"'
          [value]="pasted()"
          (input)="pasted.set($any($event.target).value)"
          data-testid="secret-paste"
        ></textarea>
        <div class="mt-2 flex flex-wrap items-center gap-3">
          <label class="text-xs text-neutral-500"
            >all at level
            <select
              [class]="field + ' inline w-auto'"
              (change)="pastedLevel.set($any($event.target).value)"
              data-testid="pasted-level"
            >
              @for (l of levels; track l) {
                <option [value]="l" [selected]="l === pastedLevel()">{{ l }}</option>
              }
            </select></label
          >
          <button
            appBtn
            variant="ghost"
            type="submit"
            [disabled]="parseDotenv(pasted()).length === 0"
            data-testid="set-pasted"
          >
            Set {{ parseDotenv(pasted()).length }} variable{{
              parseDotenv(pasted()).length === 1 ? '' : 's'
            }}
          </button>
          <span class="text-xs text-neutral-500"
            >Comments and blank lines are skipped; quotes are removed. Existing names are
            overwritten, others kept.</span
          >
        </div>
      </form>
    </details>
    @if (error(); as e) {
      <p
        class="mt-1 text-sm text-red-700 dark:text-red-400"
        role="alert"
        data-testid="secret-error"
      >
        {{ e }}
      </p>
    }
  `,
})
export class SecretsEditor {
  readonly url = input.required<string>();
  readonly initial = input<SecretListing[]>([]);
  readonly #http = inject(HttpClient);

  protected readonly field = FIELD;
  protected readonly levels = SECRET_LEVELS;
  protected readonly levelClass = LEVEL_CLASS;
  protected readonly secrets = linkedSignal<SecretListing[]>(() => this.initial());
  protected readonly draft = signal<{ name: string; value: string; level: SecretLevel }>({
    name: '',
    value: '',
    level: 'standard',
  });
  protected readonly pasted = signal('');
  protected readonly pastedLevel = signal<SecretLevel>('standard');
  protected readonly error = signal<string | null>(null);
  protected edit(key: 'name' | 'value' | 'level', v: string): void {
    this.draft.update((d) => ({ ...d, [key]: v }));
  }

  protected ready(): boolean {
    const d = this.draft();
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name) && d.value !== '';
  }

  protected async set(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.ready()) return;
    const d = this.draft();
    await this.#patch({ set: { [d.name]: { value: d.value, level: d.level } } });
    if (!this.error()) this.draft.set({ name: '', value: '', level: d.level });
  }

  protected relevel(name: string, level: SecretLevel): Promise<void> {
    return this.#patch({ levels: { [name]: level } });
  }
  protected unset(name: string): Promise<void> {
    return this.#patch({ unset: [name] });
  }

  protected parseDotenv(text: string): [string, string][] {
    const out: [string, string][] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/^export\s+/, '');
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const name = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      const q = value[0];
      const close = q === '"' || q === "'" ? value.indexOf(q, 1) : -1;
      if (close > 0) value = value.slice(1, close);
      else value = value.replace(/\s+#.*$/, '');
      if (q === '"' && close > 0) value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      out.push([name, value]);
    }
    return out;
  }

  protected async paste(e: Event): Promise<void> {
    e.preventDefault();
    const pairs = this.parseDotenv(this.pasted());
    if (pairs.length === 0) return;
    const level = this.pastedLevel();
    await this.#patch({ set: Object.fromEntries(pairs.map(([k, v]) => [k, { value: v, level }])) });
    if (!this.error()) this.pasted.set('');
  }

  async #patch(body: {
    set?: Record<string, { value: string; level: SecretLevel }>;
    unset?: string[];
    levels?: Record<string, SecretLevel>;
  }): Promise<void> {
    this.error.set(null);
    try {
      const { secrets } = await firstValueFrom(
        this.#http.patch<{ secrets: SecretListing[] }>(this.url(), body),
      );
      this.secrets.set(secrets);
    } catch (err) {
      this.error.set(toProblem(err).detail);
    }
  }
}
