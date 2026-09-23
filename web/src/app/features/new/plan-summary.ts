import { Component, input } from '@angular/core';
import type { AppPlan, Command, PlanReason } from '../../core/api.types';

const REASON_LOOK: Record<PlanReason['level'], { tone: string; mark: string }> = {
  error: { tone: 'text-red-700 dark:text-red-400', mark: '✕' },
  warn: { tone: 'text-amber-700 dark:text-amber-400', mark: '!' },
  info: { tone: 'text-neutral-600 dark:text-neutral-400', mark: '→' },
};

const commandText = (c: Command | null) =>
  c === null ? null : typeof c === 'string' ? c : c.join(' ');

function planLine(p: AppPlan): string {
  const serve =
    p.serve.kind === 'static' && p.serve.output !== false
      ? `nginx serves ${p.serve.output ?? 'the build output'}`
      : null;
  return [
    p.image,
    p.root ? `in ${p.root}/` : null,
    commandText(p.install),
    commandText(p.build),
    serve ?? commandText(p.start) ?? (p.entry ? `runs ${p.entry}` : null),
  ]
    .filter((x) => x)
    .join(' · ');
}

@Component({
  selector: 'app-plan-summary',
  host: { class: 'block' },
  template: `
    @if (plan(); as p) {
      <ul class="mx-auto mt-4 max-w-xl space-y-1 text-left text-xs" data-testid="plan">
        @for (i of p.issues; track $index) {
          <li class="flex gap-2 text-red-700 dark:text-red-400" data-testid="plan-issue">
            <span aria-hidden="true">✕</span
            ><span
              ><span class="font-mono">gangway.yml{{ i.path ? ' ' + i.path : '' }}</span
              >: {{ i.message }}</span
            >
          </li>
        }
        @for (r of p.reasons; track $index) {
          <li
            class="flex gap-2"
            [class]="reasonLook[r.level].tone"
            data-testid="plan-reason"
            [attr.data-level]="r.level"
          >
            <span aria-hidden="true">{{ reasonLook[r.level].mark }}</span>
            <span
              ><span class="font-medium">{{ r.found }}</span
              >: {{ r.then }}</span
            >
          </li>
        }
      </ul>
      @if (p.kind === 'runtime') {
        <p class="mt-2 font-mono text-[11px] text-neutral-500" data-testid="plan-summary">
          {{ line(p) }}
        </p>
      }
    } @else if (planning()) {
      <p class="mt-3 text-xs text-neutral-500" data-testid="planning">
        Working out how to build it…
      </p>
    }
  `,
})
export class PlanSummary {
  readonly plan = input.required<AppPlan | null>();
  readonly planning = input.required<boolean>();

  protected readonly reasonLook = REASON_LOOK;
  protected readonly line = planLine;
}
