import { Component, inject, input } from '@angular/core';
import type { Preview } from '../../core/api.types';
import { Clock } from '../../core/clock';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { ExtendTtl } from './extend-ttl';
import { IdleWindow } from './idle-window';

/** Two facts about how long a preview stays: when it expires and when it sleeps. */
@Component({
  selector: 'app-preview-lifetime',
  imports: [ExtendTtl, IdleWindow, RelativeTimePipe],
  host: { class: 'contents' },
  template: `
    <div class="gw-fact">
      <dt>Expires</dt>
      <dd class="flex flex-wrap items-baseline gap-x-3">
        <span [title]="preview().ttlExpiresAt ?? ''" data-testid="ttl">{{
          preview().ttlExpiresAt ? (preview().ttlExpiresAt | relativeTime: clock.now()) : 'never'
        }}</span>
        <app-extend-ttl [preview]="preview()" />
      </dd>
    </div>
    <app-idle-window [preview]="preview()" />
  `,
})
export class PreviewLifetime {
  readonly preview = input.required<Preview>();
  protected readonly clock = inject(Clock);
}
