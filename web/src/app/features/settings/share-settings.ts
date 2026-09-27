import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const ON = 'previews.share.enabled';
const MAX = 'previews.share.maxTtl';

/** Public links for previews through Cloudflare quick tunnels. */
@Component({
  selector: 'app-share-settings',
  imports: [Btn],
  host: { class: 'block' },
  template: `
    <div class="gw-section" data-testid="share-settings">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Share links</h2>
        <p class="gw-section-note">
          Share on a preview's page gives it a public https link through a Cloudflare quick tunnel,
          with no account and no DNS. It is how a local-only install shows a preview to anyone else,
          and is on by default only there. Quick tunnels are for testing: 200 requests at once, no
          server-sent events.
        </p>
      </div>
      <div class="flex flex-col gap-5">
        <label class="flex items-center gap-3 self-start" data-testid="share-on">
          <input
            type="checkbox"
            class="gw-box"
            [checked]="on()"
            [disabled]="!canWrite() || managed(on$) || saving() !== null"
            (change)="setOn($any($event.target).checked)"
          />
          <span class="text-[15px]">Allow public share links</span>
          @if (managed(on$)) {
            <span class="text-xs text-muted">managed by config</span>
          }
        </label>
        <form class="flex flex-wrap items-end gap-4" (submit)="$event.preventDefault(); saveMax()">
          <label class="gw-label min-w-48"
            >Longest a link lasts
            <input
              [class]="field"
              name="maxTtl"
              placeholder="24h"
              [value]="max()"
              (input)="max.set($any($event.target).value)"
              [disabled]="!canWrite() || managed(max$) || saving() !== null"
              data-testid="share-max"
          /></label>
          @if (canWrite() && !managed(max$)) {
            <button appBtn type="submit" [disabled]="saving() !== null || max() === savedMax()">
              {{ saving() === max$ ? 'Saving…' : 'Save' }}
            </button>
          }
        </form>
      </div>
    </div>
  `,
})
export class ShareSettings {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly field = FIELD;
  protected readonly on$ = ON;
  protected readonly max$ = MAX;
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));
  readonly #row = (key: string) => this.settings().find((s) => s.key === key);
  protected readonly on = linkedSignal(() => this.#row(ON)?.value === true);
  protected readonly savedMax = linkedSignal(() => String(this.#row(MAX)?.value ?? '24h'));
  protected readonly max = linkedSignal(() => this.savedMax());
  protected readonly managed = (key: string) => this.#row(key)?.managedByConfig === true;

  protected async setOn(on: boolean): Promise<void> {
    if (await this.#put(ON, on)) {
      this.on.set(on);
      this.#toasts.info(on ? 'Previews can be shared publicly' : 'New share links are off');
    } else this.on.set(!on);
  }

  protected async saveMax(): Promise<void> {
    const max = this.max().trim();
    if (await this.#put(MAX, max)) {
      this.savedMax.set(max);
      this.#toasts.info(`Share links last at most ${max}`);
    }
  }

  async #put(key: string, value: unknown): Promise<boolean> {
    if (this.saving() !== null) return false;
    this.saving.set(key);
    try {
      await firstValueFrom(this.#http.put('/v1/settings', { values: { [key]: value } }));
      return true;
    } catch (e) {
      this.#toasts.problem('Could not change the setting', toProblem(e));
      return false;
    } finally {
      this.saving.set(null);
    }
  }
}
