import { Component, computed, input } from '@angular/core';
import type { SseStatus } from '../core/sse.service';

const LOOK: Record<SseStatus | 'idle', { label: string; dot: string; pulse: boolean }> = {
  idle: { label: '', dot: 'bg-transparent', pulse: false },
  connecting: { label: 'connecting…', dot: 'bg-muted', pulse: true },
  live: { label: 'live', dot: 'bg-ok', pulse: false },
  reconnecting: { label: 'reconnecting…', dot: 'bg-flag', pulse: true },
  paused: { label: 'paused', dot: 'bg-muted', pulse: false },
  closed: { label: 'not live', dot: 'bg-muted', pulse: false },
};

@Component({
  selector: 'app-connection-dot',
  template: `
    @if (status() !== 'idle') {
      <span
        class="inline-flex items-center gap-1.5 font-mono text-xs text-muted"
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
