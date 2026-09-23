import { Component, input, output } from '@angular/core';
import type { AddonId, AddonInfo, AppPlan } from '../../core/api.types';
import { BrandIcon } from '../../ui/brand-icon';
import { ADDON_LOOKS } from './looks';

@Component({
  selector: 'app-addon-picker',
  host: { class: 'block' },
  imports: [BrandIcon],
  template: `
    <fieldset
      class="mt-6 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
      data-testid="addons"
    >
      <legend class="px-1 text-sm font-medium text-neutral-600 dark:text-neutral-400">
        Databases
      </legend>
      <p class="text-xs text-neutral-500">
        Temporary databases for this preview. They keep their data between saves and are removed
        with the preview.
      </p>
      <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
        @for (a of addons(); track a.id) {
          @let look = looks[a.id];
          @let on = checks().includes(a.id);
          <label
            class="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition"
            [title]="a.description"
            [style.--brand]="look.color"
            [class]="
              on
                ? 'border-[var(--brand)] bg-[color-mix(in_oklch,var(--brand)_8%,transparent)]'
                : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700'
            "
          >
            <input
              type="checkbox"
              class="sr-only"
              [checked]="on"
              (change)="toggled.emit({ id: a.id, on: $any($event.target).checked })"
              [attr.data-testid]="'addon-' + a.id"
            />
            <app-brand-icon [path]="look.path" [color]="look.color" [size]="20" />
            <span>
              <span class="font-medium">{{ a.name }}</span
              ><span class="ml-1 text-xs text-neutral-500">{{ a.defaultVersion }}</span>
              @if (because(a.id); as why) {
                <span
                  class="ml-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
                  [attr.data-testid]="'suggested-' + a.id"
                  >uses {{ why }}</span
                >
              }
              <span class="block font-mono text-[10px] text-neutral-400">{{ a.env[0] }}</span>
            </span>
            <span
              class="ml-1 grid size-4 place-items-center rounded border text-[10px]"
              [class]="
                on
                  ? 'border-[var(--brand)] bg-[var(--brand)] text-white'
                  : 'border-neutral-300 dark:border-neutral-600'
              "
              aria-hidden="true"
            >
              @if (on) {
                ✓
              }
            </span>
          </label>
        }
      </div>
    </fieldset>
  `,
})
export class AddonPicker {
  readonly addons = input.required<AddonInfo[]>();
  readonly checks = input.required<AddonId[]>();
  readonly suggested = input.required<AppPlan['suggested']>();
  readonly toggled = output<{ id: AddonId; on: boolean }>();

  protected readonly looks = ADDON_LOOKS;

  protected because(id: AddonId): string | null {
    return this.suggested().find((s) => s.id === id)?.because ?? null;
  }
}
