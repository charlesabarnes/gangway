import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { ToastService } from '../../ui/toast';

const KEY = 'artifacts.brand';

@Component({
  selector: 'app-artifact-settings',
  host: { class: 'block' },
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Artifacts</h2>
        <p class="gw-section-note">
          Documents, dashboards, decks and prototypes agents build here. A preview can override
          this.
        </p>
      </div>
      <label class="flex items-center gap-3 self-start" data-testid="artifact-brand">
        <input
          type="checkbox"
          class="gw-box"
          [checked]="brand()"
          [disabled]="!canWrite() || managed() || saving() === key"
          (change)="setBrand($any($event.target).checked)"
        />
        <span class="text-[15px]">Show a faint gangway mark in the bottom-right corner</span>
        @if (managed()) {
          <span class="text-xs text-muted">managed by config</span>
        }
      </label>
    </div>
  `,
})
export class ArtifactSettings {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly key = KEY;
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));
  readonly #row = computed(() => this.settings().find((s) => s.key === KEY));
  protected readonly brand = linkedSignal(() => this.#row()?.value !== false);
  protected readonly managed = computed(() => this.#row()?.managedByConfig === true);

  protected async setBrand(on: boolean): Promise<void> {
    if (this.saving() !== null) return;
    this.saving.set(KEY);
    try {
      await firstValueFrom(this.#http.put('/v1/settings', { values: { [KEY]: on } }));
      this.brand.set(on);
      this.#toasts.info(`Artifacts ${on ? 'show' : 'hide'} the gangway mark from their next build`);
    } catch (e) {
      this.brand.set(!on);
      this.#toasts.problem('Could not change the setting', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }
}
