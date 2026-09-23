import { Component, computed, input, model, output } from '@angular/core';
import type { AppPlan, Detected, Runtime } from '../../core/api.types';
import { BrandIcon } from '../../ui/brand-icon';
import { Btn } from '../../ui/button';
import { OWN_LABEL, RUNTIME_LOOKS } from './looks';
import type { Collected } from './pack';
import { PlanSummary } from './plan-summary';
import { RuntimeChoice } from './runtime-choice';
import { formatBytes } from './upload';

@Component({
  selector: 'app-upload-summary',
  host: { class: 'block' },
  imports: [BrandIcon, Btn, PlanSummary, RuntimeChoice],
  template: `
    @let u = upload();
    <p class="font-serif text-2xl italic" data-testid="summary">
      {{ u.files.length }} file{{ u.files.length === 1 ? '' : 's' }},
      {{ size(u.totalBytes) }}
      @if (u.skipped) {
        <span class="font-sans text-sm text-muted not-italic">
          ({{ u.skipped }} skipped: .git, node_modules, OS files)</span
        >
      }
    </p>
    <p
      class="mt-3.5 flex items-center justify-center gap-2 text-[15px] text-muted"
      data-testid="detected"
    >
      Looks like:
      <app-brand-icon
        [path]="looks[detected()].path"
        [color]="looks[detected()].color"
        [size]="16"
      /><span class="font-medium text-ink">{{ label(detected()) }}</span>
    </p>
    <app-plan-summary [plan]="plan()" [planning]="planning()" />
    <app-runtime-choice [runtimes]="runtimes()" [detected]="detected()" [(choice)]="choice" />
    <div class="mx-auto mt-5 flex max-w-md flex-wrap items-end justify-center gap-2.5">
      <button
        appBtn
        type="button"
        (click)="deploy.emit()"
        [disabled]="busy() || blocked()"
        [title]="blocked() ? 'Fix the problems above first' : ''"
        data-testid="deploy"
      >
        Deploy
      </button>
      <button
        appBtn
        variant="ghost"
        type="button"
        (click)="clear.emit()"
        [disabled]="busy()"
        data-testid="clear"
      >
        Clear
      </button>
    </div>
  `,
})
export class UploadSummary {
  readonly upload = input.required<Collected>();
  readonly detected = input.required<Detected>();
  readonly runtimes = input.required<Runtime[]>();
  readonly plan = input.required<AppPlan | null>();
  readonly planning = input.required<boolean>();
  readonly busy = input.required<boolean>();
  readonly choice = model.required<Detected | ''>();
  readonly deploy = output();
  readonly clear = output();

  protected readonly looks = RUNTIME_LOOKS;
  protected readonly size = formatBytes;

  protected readonly blocked = computed(() => {
    const p = this.plan();
    return p !== null && (p.issues.length > 0 || p.reasons.some((r) => r.level === 'error'));
  });

  protected label(d: Detected): string {
    return d === 'own' ? OWN_LABEL : (this.runtimes().find((r) => r.id === d)?.name ?? d);
  }
}
