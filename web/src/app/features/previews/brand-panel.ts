import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AppPlan, BrandChoice, Preview } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const LABELS: Record<BrandChoice, string> = {
  inherit: 'The server default',
  on: 'Show it',
  off: 'Hide it',
};

/** On an artifact preview: whether the faint gangway mark sits in the bottom-right corner. */
@Component({
  selector: 'app-brand-panel',
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    @if (artifact(); as a) {
      <h2 class="gw-label">Artifact</h2>
      <div
        class="gw-neatline flex flex-wrap items-end gap-6 px-5 py-4 text-[15px]"
        data-testid="brand-panel"
      >
        <p class="min-w-48 flex-1">
          A {{ a.kind }} drawn from
          <code class="font-mono text-xs">{{
            a.format === 'markdown' ? 'artifact.md' : 'index.html'
          }}</code
          >.
        </p>
        <label class="gw-label min-w-56"
          >gangway mark, bottom right
          <select
            [class]="field"
            [disabled]="!canChange() || saving()"
            (change)="save($any($event.target).value)"
            data-testid="brand"
          >
            @for (c of choices; track c) {
              <option [value]="c" [selected]="c === choice()">{{ labels[c] }}</option>
            }
          </select></label
        >
      </div>
    }
  `,
})
export class BrandPanel {
  readonly preview = input.required<Preview>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly field = FIELD;
  protected readonly labels = LABELS;
  protected readonly choices: BrandChoice[] = ['inherit', 'on', 'off'];
  protected readonly plan = signal<AppPlan | null>(null);
  protected readonly saving = signal(false);
  protected readonly artifact = computed(() => this.plan()?.artifact ?? null);
  protected readonly choice = computed<BrandChoice>(() => {
    const s = this.preview().source;
    return s.kind === 'tarball' ? (s.brand ?? 'inherit') : 'inherit';
  });
  protected readonly canChange = computed(
    () => this.#auth.can('previews.update') || this.#auth.can('previews.update_own'),
  );

  constructor() {
    effect(() => {
      const p = this.preview();
      if (p.source.kind !== 'tarball') return;
      firstValueFrom(this.#http.get<AppPlan>(`/v1/previews/${p.id}/plan`)).then(
        (plan) => this.plan.set(plan),
        () => this.plan.set(null),
      );
    });
  }

  protected async save(brand: BrandChoice): Promise<void> {
    if (brand === this.choice()) return;
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.#http.patch(`/v1/previews/${this.preview().id}/source`, { files: {}, brand }),
      );
      this.#toasts.info(`Rebuilding: the gangway mark will follow “${LABELS[brand]}”`);
    } catch (e) {
      this.#toasts.problem('Could not change the gangway mark', toProblem(e));
    } finally {
      this.saving.set(false);
    }
  }
}
