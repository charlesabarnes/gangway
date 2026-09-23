import { Directive, computed, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:brightness-110',
  ghost:
    'border border-neutral-300 text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

/** One look for every button and button-shaped link. `<button appBtn variant="danger">`. */
@Directive({ selector: 'button[appBtn], a[appBtn]', host: { '[class]': 'classes()' } })
export class Btn {
  readonly variant = input<ButtonVariant>('primary');
  protected readonly classes = computed(() => `${BASE} ${VARIANT[this.variant()]}`);
}
