import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const ON = 'previews.watermark';
const LINK = 'previews.watermark.link';

/** The watermark gangway adds to every page a preview answers. */
@Component({
  selector: 'app-watermark-settings',
  imports: [Btn],
  host: { class: 'block' },
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Watermark</h2>
        <p class="gw-section-note">
          gangway adds its mark to the bottom-right corner of every page a preview serves: apps,
          uploaded sites and artifacts. A repository or a preview can override this.
        </p>
      </div>
      <div class="flex flex-col gap-5">
        <label class="flex items-center gap-3 self-start" data-testid="watermark-on">
          <input
            type="checkbox"
            class="gw-box"
            [checked]="on()"
            [disabled]="!canWrite() || managed(on$) || saving() !== null"
            (change)="setOn($any($event.target).checked)"
          />
          <span class="text-[15px]">Show the gangway watermark on previews</span>
          @if (managed(on$)) {
            <span class="text-xs text-muted">managed by config</span>
          }
        </label>
        <form class="flex flex-wrap items-end gap-4" (submit)="$event.preventDefault(); saveLink()">
          <label class="gw-label min-w-72 flex-1"
            >Where the mark links to
            <input
              [class]="field"
              name="link"
              type="url"
              placeholder="No link"
              [value]="link()"
              (input)="link.set($any($event.target).value)"
              [disabled]="!canWrite() || managed(link$) || saving() !== null"
              data-testid="watermark-link"
          /></label>
          @if (canWrite() && !managed(link$)) {
            <button appBtn type="submit" [disabled]="saving() !== null || link() === savedLink()">
              {{ saving() === link$ ? 'Saving…' : 'Save' }}
            </button>
          }
        </form>
      </div>
    </div>
  `,
})
export class WatermarkSettings {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly field = FIELD;
  protected readonly on$ = ON;
  protected readonly link$ = LINK;
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));
  readonly #row = (key: string) => this.settings().find((s) => s.key === key);
  protected readonly on = linkedSignal(() => this.#row(ON)?.value !== false);
  protected readonly savedLink = linkedSignal(() => String(this.#row(LINK)?.value ?? ''));
  protected readonly link = linkedSignal(() => this.savedLink());
  protected readonly managed = (key: string) => this.#row(key)?.managedByConfig === true;

  protected async setOn(on: boolean): Promise<void> {
    if (await this.#put(ON, on)) {
      this.on.set(on);
      this.#toasts.info(
        `Previews ${on ? 'show' : 'hide'} the gangway watermark from their next page load`,
      );
    } else this.on.set(!on);
  }

  protected async saveLink(): Promise<void> {
    const link = this.link().trim();
    if (await this.#put(LINK, link)) {
      this.savedLink.set(link);
      this.#toasts.info(link ? 'The watermark links there now' : 'The watermark links nowhere now');
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
