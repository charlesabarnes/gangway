import { Component, computed, inject, input } from '@angular/core';
import type { Preview } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import type { ProblemError } from '../../core/problem';
import { ChoiceLink, type Choice } from '../../ui/choice-link';
import { relativeTime } from '../../ui/relative-time.pipe';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

const CHOICES: readonly Choice[] = [
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'none', label: 'forever' },
];

/** An Extend link that opens to how much longer; added to what the preview has left. */
@Component({
  selector: 'app-extend-ttl',
  imports: [ChoiceLink],
  host: { class: 'contents' },
  template: `
    @if (canExtend()) {
      <app-choice-link
        name="extend"
        label="Extend"
        prompt="Extend by"
        [choices]="choices"
        [pick]="extend"
      />
    }
  `,
})
export class ExtendTtl {
  readonly preview = input.required<Preview>();

  readonly #store = inject(PreviewsStore);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);
  readonly #clock = inject(Clock);

  protected readonly choices = CHOICES;
  protected readonly canExtend = computed(() => {
    const p = this.preview();
    return (
      p.ttlExpiresAt !== null &&
      p.state !== 'destroying' &&
      p.state !== 'destroyed' &&
      this.#auth.can('previews.extend') &&
      (this.#auth.can('previews.update') || this.#auth.can('previews.update_own'))
    );
  });

  protected readonly extend = async (by: string): Promise<boolean> => {
    try {
      const p = await this.#store.extend(this.preview().id, by);
      this.#toasts.info(
        p.ttlExpiresAt
          ? `Expires ${relativeTime(p.ttlExpiresAt, this.#clock.now())}`
          : 'Kept until you destroy it',
      );
      return true;
    } catch (e) {
      this.#toasts.problem('Could not extend the preview', e as ProblemError);
      if ((e as ProblemError).status === 403) void this.#auth.refresh();
      return false;
    }
  };
}
