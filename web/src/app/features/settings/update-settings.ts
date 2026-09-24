import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import type { UpdateStatus } from '../../core/update.types';
import { ToastService } from '../../ui/toast';
import { Btn } from '../../ui/button';

const KEY = 'updates.check';

@Component({
  selector: 'app-update-settings',
  host: { class: 'block' },
  imports: [Btn],
  template: `
    <div class="gw-section" data-testid="updates">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Updates</h2>
        <p class="gw-section-note">
          This server runs gangway
          <code class="font-mono" data-testid="version">{{ status()?.current ?? '…' }}</code
          >.
        </p>
      </div>
      @if (status(); as s) {
        @if (s.available) {
          <div class="flex flex-col gap-2.5" role="status" data-testid="update-available">
            <p class="flex items-center gap-2 text-[17px] font-medium">
              <span class="size-[11px] shrink-0 bg-flag" aria-hidden="true"></span>gangway
              {{ s.latest }} is available
            </p>
            <p class="text-sm leading-normal text-muted">
              Run the installer again, or on Unraid use Update in the Docker tab.
            </p>
            @if (s.url) {
              <a
                appBtn
                variant="ghost"
                size="sm"
                class="self-start"
                [href]="s.url"
                target="_blank"
                rel="noopener"
                data-testid="release-notes"
                >Release notes</a
              >
            }
          </div>
        } @else if (s.latest) {
          <p class="text-sm text-muted" data-testid="update-latest">
            Latest release: <code class="font-mono">{{ s.latest }}</code>
          </p>
        }
      }
      <label class="flex items-center gap-3 self-start" data-testid="update-check">
        <input
          type="checkbox"
          class="gw-box"
          [checked]="check()"
          [disabled]="!canWrite() || managed() || saving() === key"
          (change)="setCheck($any($event.target).checked)"
        />
        <span class="text-[15px]">Check GitHub once a day for a new release</span>
        @if (managed()) {
          <span class="text-xs text-muted">managed by config</span>
        }
      </label>
    </div>
  `,
})
export class UpdateSettings {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly key = KEY;
  protected readonly status = signal<UpdateStatus | null>(null);
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));
  readonly #row = computed(() => this.settings().find((s) => s.key === KEY));
  protected readonly check = linkedSignal(() => this.#row()?.value !== false);
  protected readonly managed = computed(() => this.#row()?.managedByConfig === true);

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      this.status.set(await firstValueFrom(this.#http.get<UpdateStatus>('/v1/updates')));
    } catch (e) {
      this.#toasts.problem('Could not check for updates', toProblem(e));
    }
  }

  protected async setCheck(on: boolean): Promise<void> {
    if (this.saving() !== null) return;
    this.saving.set(KEY);
    try {
      await firstValueFrom(this.#http.put('/v1/settings', { values: { [KEY]: on } }));
      this.check.set(on);
      this.#toasts.info(on ? 'gangway will check for new releases' : 'Update checks are off');
      await this.#load();
    } catch (e) {
      this.check.set(!on);
      this.#toasts.problem('Could not change the setting', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }
}
