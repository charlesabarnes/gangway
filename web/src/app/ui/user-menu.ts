import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStart, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import type { SessionUser } from '../core/api.types';
import { ThemeToggle } from './theme-toggle';

/** Who is logged in, and a panel under it with the account, the theme and log out. */
@Component({
  selector: 'app-user-menu',
  imports: [RouterLink, ThemeToggle],
  host: {
    class: 'contents',
    '(document:pointerdown)': 'outside($event)',
    '(document:keydown.escape)': 'escape()',
    '(window:resize)': 'close()',
  },
  template: `
    <button
      #trigger
      type="button"
      class="flex items-center gap-1.5 opacity-85 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flag"
      [class.!opacity-100]="open()"
      [attr.aria-expanded]="open()"
      aria-controls="user-menu"
      (click)="toggle()"
      data-testid="who"
    >
      <span>{{ user().email }}</span>
      <span
        class="px-1.5 py-0.5 text-[10px] font-semibold tracking-[.14em] uppercase shadow-[inset_0_0_0_1px_var(--gw-header-fg)]"
        >{{ user().role.name }}</span
      >
      <svg
        viewBox="0 0 12 12"
        class="size-3 transition-transform"
        [class.rotate-180]="open()"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" />
      </svg>
    </button>
    <!-- Fixed, not absolute: the header scrolls sideways on a phone and would clip it. -->
    <div
      #panel
      id="user-menu"
      [hidden]="!open()"
      class="fixed z-50 flex w-64 flex-col border border-ink bg-paper py-1.5 text-sm text-ink"
      [style.top.px]="at().top"
      [style.right.px]="at().right"
      data-testid="user-menu"
    >
      <a
        routerLink="/account"
        class="px-4 py-2 hover:bg-ink/5 focus-visible:bg-ink/5 focus-visible:outline-none"
        data-testid="menu-account"
        >Account</a
      >
      <div class="flex items-center justify-between gap-3 px-4 py-2">
        <span class="text-muted">Theme</span>
        <app-theme-toggle />
      </div>
      <button
        type="button"
        class="border-t border-rule px-4 py-2 text-left hover:bg-ink/5 focus-visible:bg-ink/5 focus-visible:outline-none"
        (click)="close(); logout.emit()"
        data-testid="logout"
      >
        Log out
      </button>
    </div>
  `,
})
export class UserMenu {
  readonly user = input.required<SessionUser>();
  readonly logout = output<void>();

  protected readonly open = signal(false);
  protected readonly at = signal({ top: 0, right: 0 });

  // viewChild cannot target an ES #private field (NG1053).
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  constructor() {
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationStart),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.close());
  }

  protected toggle(): void {
    if (this.open()) return this.close();
    const r = this.trigger().nativeElement.getBoundingClientRect();
    this.at.set({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }

  protected outside(e: PointerEvent): void {
    const t = e.target as Node;
    if (!this.open()) return;
    if (this.trigger().nativeElement.contains(t) || this.panel().nativeElement.contains(t)) return;
    this.close();
  }

  protected escape(): void {
    if (!this.open()) return;
    this.close();
    this.trigger().nativeElement.focus();
  }
}
