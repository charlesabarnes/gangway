import { Component, computed, inject, input, signal } from '@angular/core';
import type { Preview, WatermarkChoice } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

const LABELS: Record<WatermarkChoice, string> = {
  inherit: 'Follow the repository and server',
  on: 'Show it',
  off: 'Hide it',
};

/** Whether gangway's mark sits in the bottom-right corner of this preview's pages. */
@Component({
  selector: 'app-watermark-panel',
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    <h2 class="gw-label">Watermark</h2>
    <div
      class="gw-neatline flex flex-wrap items-end gap-6 px-5 py-4 text-[15px]"
      data-testid="watermark-panel"
    >
      <p class="min-w-48 flex-1">
        gangway adds its mark to the bottom-right corner of every page. A change shows on the next
        page load, with no rebuild.
      </p>
      <label class="gw-label min-w-56"
        >gangway watermark
        <select
          [class]="field"
          [disabled]="!canChange() || saving()"
          (change)="save($any($event.target).value)"
          data-testid="watermark"
        >
          @for (c of choices; track c) {
            <option [value]="c" [selected]="c === preview().watermark">{{ labels[c] }}</option>
          }
        </select></label
      >
    </div>
  `,
})
export class WatermarkPanel {
  readonly preview = input.required<Preview>();

  readonly #store = inject(PreviewsStore);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly field = FIELD;
  protected readonly labels = LABELS;
  protected readonly choices: WatermarkChoice[] = ['inherit', 'on', 'off'];
  protected readonly saving = signal(false);
  protected readonly canChange = computed(
    () =>
      this.#auth.can('previews.watermark') &&
      (this.#auth.can('previews.update') || this.#auth.can('previews.update_own')),
  );

  protected async save(watermark: WatermarkChoice): Promise<void> {
    if (watermark === this.preview().watermark) return;
    this.saving.set(true);
    try {
      await this.#store.setWatermark(this.preview().id, watermark);
      this.#toasts.info(`Watermark: ${LABELS[watermark].toLowerCase()}`);
    } catch (e) {
      this.#toasts.problem('Could not change the watermark', e as ProblemError);
    } finally {
      this.saving.set(false);
    }
  }
}
