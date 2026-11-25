import { Component, computed, inject, input } from '@angular/core';
import type { Preview } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { ChoiceLink, type Choice } from '../../ui/choice-link';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

const CHOICES: readonly Choice[] = [
  { value: '30m', label: '30 minutes' },
  { value: '2h', label: '2 hours' },
  { value: '1d', label: '1 day' },
  { value: 'never', label: 'never' },
];

const UNITS: readonly (readonly [number, string])[] = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1_000, 'second'],
];

export function idleText(ms: number): string {
  const [size, name] = UNITS.find(([u]) => ms % u === 0) ?? [1_000, 'second'];
  const n = Math.round(ms / size);
  return `${n} ${name}${n === 1 ? '' : 's'}`;
}

/** When an app sleeps for want of requests, with a link that opens to change it. */
@Component({
  selector: 'app-idle-window',
  imports: [ChoiceLink],
  host: { '[class.gw-fact]': 'sleeps()', '[class.hidden]': '!sleeps()' },
  template: `
    @if (sleeps()) {
      <dt>Sleeps</dt>
      <dd class="flex flex-wrap items-baseline gap-x-3">
        <span data-testid="idle">{{ now() }}</span>
        @if (canChange()) {
          <app-choice-link
            name="idle"
            toggleId="idle-change"
            label="Change"
            prompt="Sleep after"
            [choices]="choices"
            [pick]="change"
          />
        }
      </dd>
    }
  `,
})
export class IdleWindow {
  readonly preview = input.required<Preview>();

  readonly #store = inject(PreviewsStore);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly choices = CHOICES;
  /** Only containers sleep: files that gangway serves cost nothing while nobody reads them. */
  protected readonly sleeps = computed(() => {
    const p = this.preview();
    return p.kind !== 'job' && !(p.source.kind === 'tarball' && p.source.serve === 'gangway');
  });
  protected readonly now = computed(() => {
    const ms = this.preview().idleAfterMs;
    if (ms === null) return "after the server's default";
    return ms === 0 ? 'never' : `after ${idleText(ms)} idle`;
  });
  protected readonly canChange = computed(() => {
    const p = this.preview();
    return (
      p.state !== 'destroying' &&
      p.state !== 'destroyed' &&
      (this.#auth.can('previews.update') || this.#auth.can('previews.update_own'))
    );
  });

  protected readonly change = async (idle: string): Promise<boolean> => {
    try {
      const p = await this.#store.setIdle(this.preview().id, idle);
      this.#toasts.info(
        p.idleAfterMs === 0
          ? 'Stays awake'
          : `Sleeps after ${idleText(p.idleAfterMs ?? 0)} with no requests`,
      );
      return true;
    } catch (e) {
      this.#toasts.problem('Could not change when it sleeps', e as ProblemError);
      if ((e as ProblemError).status === 403) void this.#auth.refresh();
      return false;
    }
  };
}
