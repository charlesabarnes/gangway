import { Component, input, model } from '@angular/core';
import type { Detected, Runtime } from '../../core/api.types';
import { BrandIcon } from '../../ui/brand-icon';
import { RUNTIME_LOOKS } from './looks';

const CHIP = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition';
const CHIP_ON =
  'border-[var(--brand)] bg-[color-mix(in_oklch,var(--brand)_10%,transparent)] font-medium text-neutral-900 dark:text-neutral-100';
const CHIP_OFF =
  'border-neutral-200 text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400';

@Component({
  selector: 'app-runtime-choice',
  host: { class: 'block' },
  imports: [BrandIcon],
  template: `
    <p class="mt-5 text-xs text-neutral-500">Build it as</p>
    <div
      class="mx-auto mt-1.5 flex max-w-2xl flex-wrap justify-center gap-1.5"
      role="radiogroup"
      aria-label="Build it as"
      data-testid="runtime-choice"
    >
      <button
        type="button"
        role="radio"
        [attr.aria-checked]="choice() === ''"
        (click)="choice.set('')"
        [class]="chip(choice() === '')"
        [style.--brand]="looks[detected()].color ?? 'currentColor'"
        data-testid="choice-auto"
      >
        <app-brand-icon
          [path]="looks[detected()].path"
          [color]="looks[detected()].color"
          [size]="14"
        />Auto
      </button>
      @for (r of runtimes(); track r.id) {
        <button
          type="button"
          role="radio"
          [attr.aria-checked]="choice() === r.id"
          (click)="choice.set(r.id)"
          [class]="chip(choice() === r.id)"
          [style.--brand]="looks[r.id].color ?? 'currentColor'"
          [title]="r.name + ' — ' + looks[r.id].tagline"
          [attr.data-testid]="'choice-' + r.id"
        >
          <app-brand-icon [path]="looks[r.id].path" [color]="looks[r.id].color" [size]="14" />{{
            looks[r.id].name
          }}
        </button>
      }
      <button
        type="button"
        role="radio"
        [attr.aria-checked]="choice() === 'own'"
        (click)="choice.set('own')"
        [class]="chip(choice() === 'own')"
        [style.--brand]="looks.own.color"
        [title]="looks.own.tagline"
        data-testid="choice-own"
      >
        <app-brand-icon [path]="looks.own.path" [color]="looks.own.color" [size]="14" />{{
          looks.own.name
        }}
      </button>
    </div>
  `,
})
export class RuntimeChoice {
  readonly runtimes = input.required<Runtime[]>();
  readonly detected = input.required<Detected>();
  readonly choice = model.required<Detected | ''>();

  protected readonly looks = RUNTIME_LOOKS;

  protected chip(on: boolean): string {
    return `${CHIP} ${on ? CHIP_ON : CHIP_OFF}`;
  }
}
