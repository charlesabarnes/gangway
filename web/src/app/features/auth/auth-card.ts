import { Component, input } from '@angular/core';
import { Mark } from '../../ui/mark';
import { ThemeToggle } from '../../ui/theme-toggle';

@Component({
  selector: 'app-auth-card',
  imports: [Mark, ThemeToggle],
  template: `
    <main
      class="relative flex min-h-dvh items-center justify-center bg-paper bg-[linear-gradient(var(--gw-rule)_1px,transparent_1px),linear-gradient(90deg,var(--gw-rule)_1px,transparent_1px)] bg-[size:80px_80px] bg-[position:-1px_-1px] px-4 py-12"
    >
      <app-theme-toggle class="absolute top-4 right-4 bg-paper" />
      <div class="gw-neatline-strong flex w-full max-w-[380px] flex-col gap-7 bg-paper p-10">
        <div class="flex items-center gap-2.5">
          <app-mark [size]="31" />
          <span class="font-mono text-xl font-semibold tracking-[-.04em]">gangway</span>
        </div>
        <div class="flex flex-col gap-1.5">
          <h1 class="m-0 font-serif text-4xl leading-tight font-normal italic">{{ heading() }}</h1>
          <p class="m-0 text-[15px] leading-snug text-muted">
            <ng-content select="[lede]" />
          </p>
        </div>
        <div><ng-content /></div>
      </div>
    </main>
  `,
})
export class AuthCard {
  readonly heading = input.required<string>();
}

export const FIELD =
  'mt-1 block w-full rounded-none border-0 border-b border-ink bg-transparent px-0 py-2 font-mono text-base text-ink ' +
  'placeholder:text-muted focus:outline-none focus-visible:shadow-[0_2px_0_var(--gw-flag)]';
export const LABEL = 'gw-label block';
