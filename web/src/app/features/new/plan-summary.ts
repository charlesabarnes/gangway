import { Component, input } from '@angular/core';
import type { AppPlan, Command, PlanReason } from '../../core/api.types';

const REASON_LOOK: Record<PlanReason['level'], { tone: string; mark: string }> = {
  error: { tone: 'text-danger', mark: '✕' },
  warn: { tone: 'text-warn', mark: '!' },
  info: { tone: 'text-ink', mark: '→' },
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
      <ul
        class="mx-auto mt-3.5 flex max-w-xl flex-col gap-1 text-left text-[13px]"
        data-testid="plan"
      >
        @for (i of p.issues; track $index) {
          <li class="flex gap-2.5 text-danger" data-testid="plan-issue">
            <span class="font-mono" aria-hidden="true">✕</span
            ><span
              ><span class="font-mono">gangway.yml{{ i.path ? ' ' + i.path : '' }}</span
              >: {{ i.message }}</span
            >
          </li>
        }
        @for (r of p.reasons; track $index) {
          <li
            class="flex gap-2.5"
            [class]="reasonLook[r.level].tone"
            data-testid="plan-reason"
            [attr.data-level]="r.level"
          >
            <span class="font-mono" [class.text-muted]="r.level === 'info'" aria-hidden="true">{{
              reasonLook[r.level].mark
            }}</span>
            <span
              ><span class="font-semibold">{{ r.found }}</span
              >: {{ r.then }}</span
            >
          </li>
        }
      </ul>
      @if (p.kind === 'runtime') {
        <p class="mt-3.5 font-mono text-[11px] text-muted" data-testid="plan-summary">
          {{ line(p) }}
        </p>
      }
    } @else if (planning()) {
      <p class="mt-3.5 text-[13px] text-muted" data-testid="planning">
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
