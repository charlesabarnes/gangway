import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const LIMITS = [
  { key: 'limits.requests.client', label: 'Requests a minute from one visitor' },
  { key: 'limits.requests.preview', label: 'Requests a minute to one preview' },
  { key: 'limits.websockets.client', label: 'Open WebSockets per visitor' },
] as const;

/** How much preview traffic one visitor, or everyone at one preview, may send. */
@Component({
  selector: 'app-limit-settings',
  imports: [Btn],
  host: { class: 'block' },
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Traffic limits</h2>
        <p class="gw-section-note">
          Past these, a preview answers 429 and asks the visitor to wait. A visitor is an address,
          or an IPv6 /64. 0 turns a limit off.
        </p>
      </div>
      <form class="flex flex-wrap items-end gap-4" (submit)="$event.preventDefault(); save()">
        @for (l of limits; track l.key) {
          <label class="gw-label min-w-48"
            >{{ l.label }}
            <input
              [class]="field"
              type="number"
              min="0"
              [value]="values()[l.key]"
              (input)="edit(l.key, $any($event.target).value)"
              [disabled]="!canWrite() || managed(l.key) || saving() !== null"
              [attr.data-testid]="l.key"
          /></label>
        }
        @if (canWrite()) {
          <button
            appBtn
            type="submit"
            [disabled]="saving() !== null || !dirty()"
            data-testid="limits-save"
          >
            {{ saving() === 'limits' ? 'Saving…' : 'Save' }}
          </button>
        }
      </form>
    </div>
  `,
})
export class LimitSettings {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly field = FIELD;
  protected readonly limits = LIMITS;
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));
  readonly #saved = linkedSignal(() =>
    Object.fromEntries(
      LIMITS.map((l) => [l.key, Number(this.settings().find((s) => s.key === l.key)?.value ?? 0)]),
    ),
  );
  protected readonly values = linkedSignal(() => ({ ...this.#saved() }));
  protected readonly dirty = computed(() =>
    LIMITS.some((l) => this.values()[l.key] !== this.#saved()[l.key]),
  );
  protected readonly managed = (key: string) =>
    this.settings().find((s) => s.key === key)?.managedByConfig === true;

  protected edit(key: string, raw: string): void {
    this.values.update((v) => ({ ...v, [key]: Math.max(0, Math.floor(Number(raw) || 0)) }));
  }

  protected async save(): Promise<void> {
    if (this.saving() !== null) return;
    const changed = LIMITS.filter(
      (l) => !this.managed(l.key) && this.values()[l.key] !== this.#saved()[l.key],
    ).map((l) => [l.key, this.values()[l.key]]);
    this.saving.set('limits');
    try {
      await firstValueFrom(this.#http.put('/v1/settings', { values: Object.fromEntries(changed) }));
      this.#saved.set({ ...this.values() });
      this.#toasts.info('Traffic limits saved');
    } catch (e) {
      this.#toasts.problem('Could not save the limits', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }
}
