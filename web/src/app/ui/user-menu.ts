import { HttpClient } from '@angular/common/http';
import {
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStart, Router, RouterLink } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import type { SessionUser } from '../core/api.types';
import { HARD_NAVIGATE } from '../core/auth.guard';
import { AuthService } from '../core/auth.service';
import type { MyOrg } from '../core/org.types';
import { toProblem } from '../core/problem';
import { ThemeToggle } from './theme-toggle';
import { ToastService } from './toast';

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
      @if (orgPage()) {
        <a
          routerLink="/org"
          class="px-4 py-2 hover:bg-ink/5 focus-visible:bg-ink/5 focus-visible:outline-none"
          data-testid="menu-org"
          >Organisation</a
        >
      }
      @if (orgs().length > 1) {
        <div
          class="flex flex-col border-t border-rule py-1"
          role="group"
          aria-labelledby="org-switcher-label"
          data-testid="org-switcher"
        >
          <p id="org-switcher-label" class="gw-label px-4 pt-1.5 pb-1 text-muted">
            Switch organisation
          </p>
          @for (o of orgs(); track o.id) {
            <button
              type="button"
              class="flex items-center justify-between gap-3 px-4 py-2 text-left hover:bg-ink/5 focus-visible:bg-ink/5 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
              [attr.aria-current]="o.current ? 'true' : null"
              [disabled]="o.current || switching()"
              (click)="switchTo(o)"
              data-testid="org-option"
            >
              <span class="truncate" [class.font-semibold]="o.current">{{ o.name }}</span>
              @if (o.current) {
                <svg
                  viewBox="0 0 12 12"
                  class="size-3 shrink-0 text-flag"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.75"
                  aria-label="current"
                >
                  <path d="M2 6.5 5 9l5-6" />
                </svg>
              } @else {
                <span class="shrink-0 text-[11px] tracking-[.08em] text-muted uppercase">{{
                  o.role.name
                }}</span>
              }
            </button>
          }
        </div>
      }
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

  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #navigate = inject(HARD_NAVIGATE);
  readonly #toasts = inject(ToastService);

  protected readonly open = signal(false);
  protected readonly at = signal({ top: 0, right: 0 });
  protected readonly orgs = signal<MyOrg[]>([]);
  protected readonly switching = signal(false);
  #orgsAsked = false;

  // Self-hosted has one org and no plan, so the page shows up only where there is a choice or a plan.
  protected readonly orgPage = computed(
    () =>
      this.#auth.can('org.read') &&
      (this.orgs().length > 1 || this.orgs().some((o) => o.current && !o.home)),
  );

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
    this.#loadOrgs();
  }

  // Asked once, on the first open: most people have one org and never need the answer.
  #loadOrgs(): void {
    if (this.#orgsAsked) return;
    this.#orgsAsked = true;
    this.#http.get<{ orgs: MyOrg[] }>('/v1/me/orgs').subscribe({
      next: (r) => this.orgs.set(r.orgs),
      error: () => {
        this.#orgsAsked = false;
      },
    });
  }

  protected async switchTo(o: MyOrg): Promise<void> {
    this.switching.set(true);
    try {
      await firstValueFrom(this.#http.put('/v1/session/org', { orgId: o.id }));
      // A full load, so no list, cache or event stream from the last org carries over.
      this.#navigate('/previews');
    } catch (e) {
      this.switching.set(false);
      this.#toasts.problem(`Could not switch to ${o.name}`, toProblem(e));
    }
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
