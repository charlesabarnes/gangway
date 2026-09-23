import { Directive, computed, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-[2px] font-semibold tracking-[.1em] whitespace-nowrap uppercase transition ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flag ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

// An outline button gives a pixel of padding to its border, so both are the same height.
const SIZE: Record<ButtonSize, { filled: string; outline: string }> = {
  md: { filled: 'px-4 py-2.5 text-[13px]', outline: 'px-[15px] py-[9px] text-[13px]' },
  sm: { filled: 'px-3.5 py-[7px] text-xs', outline: 'px-[13px] py-1.5 text-xs' },
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:brightness-110',
  ghost: 'border border-ink bg-transparent text-ink hover:bg-ink/5',
  danger: 'bg-danger text-white hover:brightness-110',
};

@Directive({ selector: 'button[appBtn], a[appBtn]', host: { '[class]': 'classes()' } })
export class Btn {
  readonly variant = input<ButtonVariant>('primary');
  readonly size = input<ButtonSize>('md');
  protected readonly classes = computed(() => {
    const size = SIZE[this.size()][this.variant() === 'ghost' ? 'outline' : 'filled'];
    return `${BASE} ${size} ${VARIANT[this.variant()]}`;
  });
}
