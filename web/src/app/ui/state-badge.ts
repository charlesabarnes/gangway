import { Component, computed, input } from '@angular/core';
import type { PreviewState } from '../core/api.types';

// A preview state is a flag: a colored square with the word beside it.
const LOOK: Record<PreviewState, { label: string; flag: string; text: string; pulse: boolean }> = {
  building: { label: 'building', flag: 'bg-flag', text: '', pulse: true },
  starting: { label: 'starting', flag: 'bg-flag', text: '', pulse: true },
  awake: { label: 'awake', flag: 'bg-ok', text: '', pulse: false },
  asleep: { label: 'asleep', flag: 'bg-muted', text: '', pulse: false },
  failed: { label: 'failed', flag: 'bg-danger', text: '', pulse: false },
  destroying: { label: 'destroying', flag: 'bg-rule', text: 'text-muted', pulse: true },
  destroyed: {
    label: 'destroyed',
    flag: 'bg-transparent',
    text: 'line-through opacity-50',
    pulse: false,
  },
};

@Component({
  selector: 'app-state-badge',
  template: `
    <span
      class="inline-flex items-center gap-[7px] text-[15px] font-medium"
      [class]="look().text"
      [attr.data-state]="state()"
    >
      <span
        class="size-[11px] shrink-0 shadow-[inset_0_0_0_1px_rgb(0_0_0/.15)]"
        [class]="look().flag"
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
