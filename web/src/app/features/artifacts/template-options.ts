import { Component, input, output } from '@angular/core';
import type { OptionValue, TemplateOption } from '../../core/artifacts.types';
import { FIELD } from '../../ui/field';

/** A built-in template's options, each drawn as the control its kind asks for. */
@Component({
  selector: 'app-template-options',
  host: { class: 'contents' },
  template: `
    @for (o of options(); track o.key) {
      <div class="gw-label flex flex-col gap-1" [attr.data-testid]="'opt-' + o.key">
        {{ o.label }}
        @switch (o.kind) {
          @case ('number') {
            <input
              type="number"
              [attr.aria-label]="o.label"
              [class]="field"
              [min]="o.min"
              [max]="o.max"
              [value]="value(o)"
              (input)="set(o.key, +$any($event.target).value)"
            />
          }
          @case ('boolean') {
            <input
              type="checkbox"
              [attr.aria-label]="o.label"
              class="gw-box mt-1"
              [checked]="value(o)"
              (change)="set(o.key, $any($event.target).checked)"
            />
          }
          @case ('choice') {
            <select
              [class]="field"
              [attr.aria-label]="o.label"
              (change)="set(o.key, $any($event.target).value)"
            >
              @for (c of o.choices; track c.value) {
                <option [value]="c.value" [selected]="c.value === value(o)">{{ c.label }}</option>
              }
            </select>
          }
        }
      </div>
    }
  `,
})
export class TemplateOptions {
  readonly options = input.required<TemplateOption[]>();
  readonly values = input.required<Record<string, OptionValue>>();
  readonly changed = output<{ key: string; value: OptionValue }>();
  protected readonly field = FIELD;

  protected value(o: TemplateOption): OptionValue {
    return this.values()[o.key] ?? o.default;
  }

  protected set(key: string, value: OptionValue): void {
    this.changed.emit({ key, value });
  }
}
