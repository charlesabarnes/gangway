import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import type { PreviewState } from '../../core/api.types';
import type { RedeployEvent } from '../previews/previews.store';

/**
 * The live preview, framed (ADR-0016). It is the REAL URL, not a simulation: what is
 * served here is what anyone opening the link gets. It reloads itself when a rebuild goes
 * live, and says so while one is in progress.
 *
 * Sandboxed without `allow-top-navigation`: a preview can do what a page does, except take
 * the gangway tab somewhere else. `allow-same-origin` is safe here because the preview is a
 * different origin from the app; it lets the preview use its own cookies and storage.
 */
@Component({
  selector: 'app-preview-frame',
  template: `
    <div class="flex h-full flex-col overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <form class="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900" (submit)="$event.preventDefault(); go()">
        <button type="button" (click)="reload()" class="rounded px-1.5 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100" title="Reload" aria-label="Reload the preview" data-testid="frame-reload">↻</button>
        <span class="truncate font-mono text-xs text-neutral-400">{{ origin() }}</span>
        <input class="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-0.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"
               [value]="path()" (input)="draft.set($any($event.target).value)" aria-label="Path" data-testid="frame-path" />
        <a [href]="current()" target="_blank" rel="noopener noreferrer" class="shrink-0 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100" data-testid="frame-open">Open in tab ↗</a>
      </form>
      <div class="relative flex-1 bg-white">
        @if (url()) {
          <iframe [src]="safe()" class="absolute inset-0 size-full" title="Preview"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                  data-testid="frame"></iframe>
        }
        @if (overlay(); as text) {
          <div class="absolute inset-0 grid place-items-center bg-white/70 text-sm text-neutral-600 backdrop-blur-[1px] dark:bg-neutral-950/70 dark:text-neutral-300" role="status" data-testid="frame-overlay">
            <span class="flex items-center gap-2"><span class="size-2 animate-pulse rounded-full bg-accent"></span>{{ text }}</span>
          </div>
        }
      </div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class PreviewFrame {
  /** The preview's primary URL (origin + `/`). */
  readonly url = input.required<string | null>();
  readonly state = input.required<PreviewState>();
  readonly redeploy = input<RedeployEvent | undefined>(undefined);

  protected readonly origin = computed(() => { const u = this.url(); return u ? new URL(u).origin : ''; });
  readonly path = signal('/');
  protected readonly draft = signal('/');
  /** Bumped to force a reload of the same URL: a changed src is the only reload a sandboxed frame takes from us. */
  readonly #nonce = signal(0);
  readonly current = computed(() => {
    const o = this.origin();
    if (!o) return '';
    const n = this.#nonce();
    let u = new URL(this.path(), o);
    // The path box may say `//elsewhere` or `javascript:`; the frame shows THIS preview, or its root.
    if (u.origin !== o) u = new URL('/', o);
    // A throwaway query parameter makes the same path a new src; the app never sees it as meaningful.
    if (n > 0) u.searchParams.set('_gw', String(n));
    return u.toString();
  });

  readonly #sanitizer = inject(DomSanitizer);
  /** The preview's own URL, from the server's record of it -- never anything typed into the page but a path. */
  protected readonly safe = computed(() => this.#sanitizer.bypassSecurityTrustResourceUrl(this.current()));

  protected readonly overlay = computed(() => {
    const s = this.state(), r = this.redeploy();
    if (r?.phase === 'started') return 'Rebuilding… the previous version serves until the new one is live';
    if (s === 'building' || s === 'starting') return 'Starting…';
    if (s === 'failed') return 'This preview failed — see the log';
    if (s === 'destroying' || s === 'destroyed') return 'This preview is gone';
    return null;
  });

  constructor() {
    // Reload when a rebuild goes live, and when the preview comes (back) up.
    let lastBuild: string | undefined;
    let lastState: PreviewState | undefined;
    effect(() => {
      const r = this.redeploy(), s = this.state();
      untracked(() => {
        const live = r?.phase === 'succeeded' && r.buildId !== lastBuild;
        const up = s === 'awake' && lastState !== undefined && lastState !== 'awake';
        if (r?.phase === 'succeeded') lastBuild = r.buildId;
        lastState = s;
        if (live || up) this.reload();
      });
    });
  }

  reload(): void { this.#nonce.update((n) => n + 1); }

  protected go(): void {
    const p = this.draft().trim() || '/';
    this.path.set(p.startsWith('/') ? p : `/${p}`);
    this.reload();
  }
}
