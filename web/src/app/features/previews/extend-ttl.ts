import { Component, computed, inject, input, signal } from '@angular/core';
import type { Preview } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import type { ProblemError } from '../../core/problem';
import { relativeTime } from '../../ui/relative-time.pipe';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

const CHOICES = [
  { by: '1d', label: '+1 day' },
  { by: '7d', label: '+7 days' },
  { by: '30d', label: '+30 days' },
  { by: 'none', label: 'Keep forever' },
] as const;

/** One click to push back when the TTL sweep tears a preview down; added to what it has left. */
@Component({
  selector: 'app-extend-ttl',
  host: { class: 'inline-flex flex-wrap items-baseline gap-x-3 gap-y-1' },
  template: `
    @if (canExtend()) {
      <span class="text-muted" aria-hidden="true">·</span>
      @for (c of choices; track c.by) {
        <button
          type="button"
          class="text-[13px] text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50"
          [disabled]="saving()"
          (click)="extend(c.by)"
          [attr.data-testid]="'extend-' + c.by"
        >
          {{ c.label }}
        </button>
      }
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
  protected readonly saving = signal(false);
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

  protected async extend(by: string): Promise<void> {
    this.saving.set(true);
    try {
      const p = await this.#store.extend(this.preview().id, by);
      this.#toasts.info(
        p.ttlExpiresAt
          ? `Expires ${relativeTime(p.ttlExpiresAt, this.#clock.now())}`
          : 'Kept until you destroy it',
      );
    } catch (e) {
      this.#toasts.problem('Could not extend the preview', e as ProblemError);
      if ((e as ProblemError).status === 403) void this.#auth.refresh();
    } finally {
      this.saving.set(false);
    }
  }
}
