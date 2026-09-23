import { Component, input, output } from '@angular/core';
import type { AddonId, AddonInfo, AppPlan } from '../../core/api.types';
import { BrandIcon } from '../../ui/brand-icon';
import { ADDON_LOOKS } from './looks';

@Component({
  selector: 'app-addon-picker',
  host: { class: 'block' },
  imports: [BrandIcon],
  template: `
    <fieldset class="m-0 min-w-0 border-0 p-0" data-testid="addons">
      <legend class="gw-label float-left mr-4">Databases</legend>
      <p class="text-sm text-muted">
        Temporary databases for this preview. They keep their data between saves and are removed
        with the preview.
      </p>
      <div class="clear-both flex flex-wrap gap-3 pt-2.5">
        @for (a of addons(); track a.id) {
          @let look = looks[a.id];
          @let on = checks().includes(a.id);
          <label
            class="flex min-w-56 flex-1 cursor-pointer items-center gap-3 bg-surface px-3.5 py-3 transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-flag"
            [title]="a.description"
            [style.--brand]="look.color"
            [class]="
              on
                ? 'shadow-[inset_0_0_0_1px_var(--gw-ink)]'
                : 'shadow-[inset_0_0_0_1px_var(--gw-rule)] hover:shadow-[inset_0_0_0_1px_var(--gw-muted)]'
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
            <span class="flex flex-col gap-0.5">
              <span class="text-[15px] font-medium whitespace-nowrap"
                >{{ a.name }}<span class="ml-1 text-[13px] text-muted">{{ a.defaultVersion }}</span>
                @if (because(a.id); as why) {
                  <span
                    class="ml-1.5 bg-flag px-1.5 py-px text-[10px] font-semibold tracking-[.1em] text-flag-fg uppercase"
                    [attr.data-testid]="'suggested-' + a.id"
                    >uses {{ why }}</span
                  >
                }
              </span>
              <span class="block font-mono text-[11px] text-muted">{{ a.env[0] }}</span>
            </span>
            <span
              class="ml-auto grid size-3.5 shrink-0 place-items-center text-[10px] shadow-[inset_0_0_0_1px_var(--gw-ink)]"
              [class]="on ? 'bg-ink text-paper' : ''"
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
