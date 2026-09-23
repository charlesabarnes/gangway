import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { AppPlan } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { StateBadge } from '../../ui/state-badge';
import { LogViewer } from '../previews/log-viewer';
import { PreviewsStore } from '../previews/previews.store';
import { SourcePanel } from '../previews/source-panel';
import { displayName, primaryUrl } from '../previews/source-label';
import { DbBrowser } from './db-browser';
import { PreviewFrame } from './preview-frame';

type Tab = 'log' | 'plan' | 'data';
const SPLIT_KEY = 'gangway.workspace.split';

/**
 * The workspace (ADR-0016): the source on the left, the REAL preview on the right, and a
 * drawer under it for the log, the plan and the databases. ⌘S saves and rebuilds; the frame
 * reloads itself when the new version is live. Full-screen: the app header is hidden here.
 */
@Component({
  selector: 'app-workspace',
  imports: [RouterLink, StateBadge, SourcePanel, PreviewFrame, LogViewer, DbBrowser],
  template: `
    @if (preview(); as p) {
      <div class="flex h-dvh flex-col">
        <header class="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
          <a [routerLink]="['/previews', p.id]" class="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100" data-testid="ws-back">← {{ name() }}</a>
          <app-state-badge [state]="p.state" />
          <span class="text-xs text-neutral-500">⌘S saves and rebuilds · the preview reloads when the new version is live</span>
        </header>

        <div class="flex min-h-0 flex-1" (pointermove)="drag($event)" (pointerup)="dragging.set(false)" (pointerleave)="dragging.set(false)">
          <div class="min-w-0 overflow-auto px-4 pb-4" [style.width.%]="split()" data-testid="ws-source">
            <app-source-panel [previewId]="p.id" [uploaded]="p.source.kind === 'tarball'" />
          </div>
          <div class="w-1.5 shrink-0 cursor-col-resize bg-neutral-100 hover:bg-accent/40 dark:bg-neutral-900" (pointerdown)="dragging.set(true); $event.preventDefault()"
               role="separator" aria-orientation="vertical" aria-label="Resize" data-testid="ws-split"></div>
          <div class="flex min-w-0 flex-1 flex-col gap-2 p-2">
            <div class="min-h-0 flex-[3]">
              <app-preview-frame [url]="url()" [state]="p.state" [redeploy]="redeploy()" />
            </div>
            <div class="flex min-h-0 flex-[2] flex-col overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
              <div class="flex gap-1 border-b border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800" role="tablist">
                @for (t of tabs(); track t.id) {
                  <button type="button" role="tab" (click)="tab.set(t.id)" [attr.aria-selected]="tab() === t.id" [attr.data-testid]="'ws-tab-' + t.id"
                          class="rounded px-2 py-0.5" [class]="tab() === t.id ? 'bg-neutral-200 dark:bg-neutral-800' : 'text-neutral-500'">{{ t.label }}</button>
                }
              </div>
              <div class="min-h-0 flex-1 overflow-auto">
                @switch (tab()) {
                  @case ('log') { @if (canLogs()) { <app-log-viewer [previewId]="p.id" [compact]="true" /> } @else { <p class="p-4 text-sm text-neutral-500">Reading logs needs logs.read.</p> } }
                  @case ('plan') {
                    <ul class="space-y-1 p-3 text-xs" data-testid="ws-plan">
                      @for (r of plan()?.reasons ?? []; track $index) {
                        <li [class]="r.level === 'error' ? 'text-red-700 dark:text-red-400' : r.level === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-neutral-600 dark:text-neutral-400'"><span class="font-medium">{{ r.found }}</span>: {{ r.then }}</li>
                      } @empty { <li class="text-neutral-500">{{ plan() === null ? 'Loading…' : 'Nothing to say.' }}</li> }
                    </ul>
                  }
                  @case ('data') { <app-db-browser [previewId]="p.id" /> }
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    } @else {
      <p class="p-8 text-sm text-neutral-500" data-testid="ws-loading">Loading…</p>
    }
  `,
})
export class Workspace {
  readonly id = input.required<string>();

  readonly #store = inject(PreviewsStore);
  readonly #auth = inject(AuthService);
  readonly #http = inject(HttpClient);

  protected readonly preview = computed(() => this.#store.byId(this.id())());
  protected readonly name = computed(() => { const p = this.preview(); return p ? displayName(p) : ''; });
  protected readonly url = computed(() => { const p = this.preview(); return p ? primaryUrl(p) : null; });
  protected readonly redeploy = computed(() => this.#store.redeployOf(this.id())());
  protected readonly canLogs = computed(() => this.#auth.can('logs.read'));
  protected readonly tabs = computed(() => [
    { id: 'log' as const, label: 'Log' },
    { id: 'plan' as const, label: 'Plan' },
    ...(this.#auth.can('previews.data') ? [{ id: 'data' as const, label: 'Database' }] : []),
  ]);
  readonly tab = signal<Tab>('log');
  readonly plan = signal<AppPlan | null>(null);

  /** The source pane's share of the width, remembered per browser. */
  readonly split = signal(readSplit());
  protected readonly dragging = signal(false);

  constructor() {
    this.#store.connect();
    inject(DestroyRef).onDestroy(() => this.#store.disconnect());
    effect(() => {
      const id = this.id();
      if (this.#store.loading() || this.#store.byId(id)()) return;
      untracked(() => void this.#store.load(id));
    });
    // The plan: on open, and again after every rebuild (a save may have changed gangway.yml).
    effect(() => {
      const id = this.id();
      void this.redeploy()?.phase;
      if (!this.preview()) return;
      untracked(() => void firstValueFrom(this.#http.get<AppPlan>(`/v1/previews/${id}/plan`)).then((p) => this.plan.set(p), () => this.plan.set(null)));
    });
  }

  protected drag(e: PointerEvent): void {
    if (!this.dragging()) return;
    const host = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pct = Math.min(75, Math.max(20, ((e.clientX - host.left) / host.width) * 100));
    this.split.set(Math.round(pct));
    try { localStorage.setItem(SPLIT_KEY, String(Math.round(pct))); } catch { /* storage may be off */ }
  }
}

function readSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= 20 && v <= 75 ? v : 45;
  } catch {
    return 45;
  }
}
