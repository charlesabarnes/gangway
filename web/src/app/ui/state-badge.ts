import { Component, computed, input } from '@angular/core';
import type { PreviewState } from '../core/api.types';

const LOOK: Record<PreviewState, { label: string; dot: string; text: string; pulse: boolean }> = {
  building: { label: 'building', dot: 'bg-accent', text: 'text-accent', pulse: true },
  starting: { label: 'starting', dot: 'bg-accent', text: 'text-accent', pulse: true },
  awake: {
    label: 'awake',
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-400',
    pulse: false,
  },
  asleep: {
    label: 'asleep',
    dot: 'bg-neutral-400',
    text: 'text-neutral-600 dark:text-neutral-400',
    pulse: false,
  },
  failed: {
    label: 'failed',
    dot: 'bg-red-500',
    text: 'text-red-700 dark:text-red-400',
    pulse: false,
  },
  destroying: { label: 'destroying', dot: 'bg-neutral-400', text: 'text-neutral-500', pulse: true },
  destroyed: {
    label: 'destroyed',
    dot: 'bg-neutral-300 dark:bg-neutral-700',
    text: 'text-neutral-400 line-through',
    pulse: false,
  },
};

/** Always a WORD beside the colour: state must not be readable by hue alone. */
@Component({
  selector: 'app-state-badge',
  template: `
    <span
      class="inline-flex items-center gap-1.5 text-sm font-medium"
      [class]="look().text"
      [attr.data-state]="state()"
    >
      <span
        class="size-2 rounded-full"
        [class]="look().dot"
        [class.animate-pulse]="look().pulse"
        aria-hidden="true"
      ></span
      >{{ look().label }}
    </span>
  `,
})
export class StateBadge {
  readonly state = input.required<PreviewState>();
  protected readonly look = computed(() => LOOK[this.state()]);
}
