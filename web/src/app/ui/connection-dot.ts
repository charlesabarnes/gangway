import { Component, computed, input } from '@angular/core';
import type { SseStatus } from '../core/sse.service';

const LOOK: Record<SseStatus | 'idle', { label: string; dot: string; pulse: boolean }> = {
  idle: { label: '', dot: 'bg-transparent', pulse: false },
  connecting: { label: 'connecting…', dot: 'bg-neutral-400', pulse: true },
  live: { label: 'live', dot: 'bg-emerald-500', pulse: false },
  reconnecting: { label: 'reconnecting…', dot: 'bg-amber-500', pulse: true },
  paused: { label: 'paused', dot: 'bg-neutral-400', pulse: false },
  closed: { label: 'not live', dot: 'bg-neutral-400', pulse: false },
};

@Component({
  selector: 'app-connection-dot',
  template: `
    @if (status() !== 'idle') {
      <span
        class="inline-flex items-center gap-1.5 text-xs text-neutral-500"
        role="status"
        data-testid="connection"
      >
        <span
          class="size-1.5 rounded-full"
          [class]="look().dot"
          [class.animate-pulse]="look().pulse"
          aria-hidden="true"
        ></span
        >{{ look().label }}
      </span>
    }
  `,
})
export class ConnectionDot {
  readonly status = input.required<SseStatus | 'idle'>();
  protected readonly look = computed(() => LOOK[this.status()]);
}
