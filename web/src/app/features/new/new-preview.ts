import { HttpClient, HttpEventType } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, last, tap } from 'rxjs';
import { VISIBILITIES, type Detected, type Preview, type Project, type Runtime, type RuntimeList, type Template } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem, type ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { collectFromDrop, collectFromFiles, detect, packFiles, packStarter, UploadError, type Collected } from './pack';
import { deployQuery, formatBytes, problemNotes } from './upload';

const FIELD = 'block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';

/** `own` is not a runtime: the upload's own compose file or Dockerfile. */
export const OWN_LABEL = 'Own Dockerfile / compose';

/**
 * New preview (ADR-0015; the spec's Deploy screen). Two ways in on one page: start from a
 * runtime's starter, or drop files, folders or a zip. Both become ONE tar.gz posted to
 * `/v1/previews` -- the same upload path an agent or a script uses.
 */
@Component({
  selector: 'app-new-preview',
  imports: [Btn, RouterLink],
  template: `
    <section class="mx-auto max-w-5xl px-6 py-10">
      <a routerLink="/previews" class="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">← Previews</a>
      <h1 class="mt-4 text-2xl font-semibold tracking-tight">New preview</h1>

      @if (!canDeploy()) {
        <p class="mt-6 text-sm text-neutral-600 dark:text-neutral-400" data-testid="no-permission">Your role cannot deploy previews. Ask an administrator for <code class="font-mono text-xs">previews.deploy</code>.</p>
      } @else {
        <h2 class="mt-8 text-sm font-medium text-neutral-500">Start from a runtime</h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">A hello-world you can edit in the browser. Saving rebuilds it at the same URL.</p>
        <ul class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="runtimes">
          @for (r of runtimes(); track r.id) {
            <li>
              <button type="button" (click)="startFrom(r)" [disabled]="busy()" [attr.data-testid]="'starter-' + r.id"
                      class="flex h-full w-full flex-col rounded-lg border border-neutral-200 p-4 text-left transition hover:border-accent disabled:opacity-50 dark:border-neutral-800">
                <span class="flex items-baseline gap-2"><span class="font-medium">{{ r.name }}</span><span class="text-xs text-neutral-500">{{ r.language }}</span></span>
                <span class="mt-1 line-clamp-3 text-xs text-neutral-600 dark:text-neutral-400">{{ r.description }}</span>
                <span class="mt-auto pt-2 font-mono text-[11px] text-neutral-400">{{ r.image }}</span>
              </button>
            </li>
          } @empty {
            <li class="text-sm text-neutral-500" data-testid="runtimes-loading">{{ runtimesError() ?? 'Loading runtimes…' }}</li>
          }
        </ul>

        <h2 class="mt-10 text-sm font-medium text-neutral-500">Or upload files</h2>
        <div (dragover)="over($event)" (dragleave)="dragging.set(false)" (drop)="dropped($event)" data-testid="dropzone"
             class="mt-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition"
             [class]="dragging() ? 'border-accent bg-accent/5' : 'border-neutral-300 dark:border-neutral-700'">
          @if (upload(); as u) {
            <p class="font-medium" data-testid="summary">{{ u.files.length }} file{{ u.files.length === 1 ? '' : 's' }}, {{ size(u.totalBytes) }}@if (u.skipped) { <span class="font-normal text-neutral-500"> ({{ u.skipped }} skipped: .git, node_modules, OS files)</span> }</p>
            <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400" data-testid="detected">Looks like: <span class="font-medium">{{ label(detected()) }}</span></p>
            <div class="mx-auto mt-4 flex max-w-md flex-wrap items-end justify-center gap-3">
              <label class="text-left text-xs text-neutral-500">Build it as
                <select [class]="field" (change)="choice.set($any($event.target).value)" data-testid="runtime-select">
                  <option value="" [selected]="choice() === ''">Auto — {{ label(detected()) }}</option>
                  @for (r of runtimes(); track r.id) { <option [value]="r.id" [selected]="choice() === r.id">{{ r.name }}</option> }
                  <option value="own" [selected]="choice() === 'own'">{{ ownLabel }}</option>
                </select>
              </label>
              <button appBtn type="button" (click)="deployUpload()" [disabled]="busy()" data-testid="deploy">Deploy</button>
              <button appBtn variant="ghost" type="button" (click)="clear()" [disabled]="busy()" data-testid="clear">Clear</button>
            </div>
          } @else {
            <p class="font-medium">Drop files, a folder or a .zip here</p>
            <p class="mt-1 text-sm text-neutral-500">A compose file or Dockerfile at the root is used as it is; anything else is built by a runtime, picked from what is there.</p>
            <div class="mt-4 flex justify-center gap-3">
              <label class="cursor-pointer rounded-md border border-neutral-300 px-3.5 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
                Choose files<input type="file" multiple class="sr-only" (change)="picked($event)" data-testid="pick-files" />
              </label>
              <label class="cursor-pointer rounded-md border border-neutral-300 px-3.5 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
                Choose a folder<input type="file" webkitdirectory class="sr-only" (change)="picked($event)" data-testid="pick-folder" />
              </label>
            </div>
          }
        </div>

        <details class="mt-6 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800" data-testid="options">
          <summary class="cursor-pointer text-sm font-medium text-neutral-600 dark:text-neutral-400">Options</summary>
          <div class="mt-3 grid gap-3 sm:grid-cols-5">
            <label class="text-xs text-neutral-500 sm:col-span-2">Name<input [class]="field" [placeholder]="namePlaceholder()" [value]="name()" (input)="name.set($any($event.target).value)" data-testid="name" /></label>
            <label class="text-xs text-neutral-500">Visibility<select [class]="field" (change)="visibility.set($any($event.target).value)" data-testid="visibility">
              <option value="">the template's</option>
              @for (v of visibilities; track v) { <option [value]="v">{{ v }}</option> }</select></label>
            <label class="text-xs text-neutral-500">TTL<input [class]="field" placeholder="the template's" [value]="ttl()" (input)="ttl.set($any($event.target).value)" data-testid="ttl" /></label>
            <span class="self-end pb-2 text-xs text-neutral-500">12h, 7d, or none</span>
            <label class="text-xs text-neutral-500 sm:col-span-2">Project<select [class]="field" (change)="project.set($any($event.target).value)" data-testid="project">
              <option value="">none</option>
              @for (p of projects(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></label>
            <label class="text-xs text-neutral-500 sm:col-span-2">Template<select [class]="field" (change)="template.set($any($event.target).value)" data-testid="template">
              <option value="">the default for manual deploys</option>
              @for (t of templates(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }</select></label>
          </div>
        </details>

        @if (progress() !== null) {
          <div class="mt-6" data-testid="progress">
            <div class="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"><div class="h-full bg-accent transition-all" [style.width.%]="progress()"></div></div>
            <p class="mt-1 text-xs text-neutral-500">Uploading… {{ progress() }}%</p>
          </div>
        }

        @if (error(); as e) {
          <div class="mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300" role="alert" data-testid="error">
            <p class="font-medium">{{ e.title }}</p>
            <p class="mt-1">{{ e.detail }}@if (e.requestId) { <span class="font-mono text-xs opacity-70"> (request {{ e.requestId }})</span> }</p>
            @if (notes().length > 0) {
              <ul class="mt-2 list-disc space-y-1 pl-5 font-mono text-xs whitespace-pre-wrap" data-testid="notes">
                @for (n of notes(); track $index) { <li>{{ n }}</li> }
              </ul>
            }
          </div>
        }
      }
    </section>
  `,
})
export class NewPreview {
  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  protected readonly field = FIELD;
  protected readonly visibilities = VISIBILITIES;
  protected readonly ownLabel = OWN_LABEL;
  protected readonly size = formatBytes;

  protected readonly canDeploy = computed(() => this.#auth.can('previews.deploy'));
  protected readonly list = signal<RuntimeList | null>(null);
  protected readonly runtimes = computed(() => this.list()?.runtimes ?? []);
  protected readonly runtimesError = signal<string | null>(null);
  protected readonly projects = signal<Project[]>([]);
  protected readonly templates = signal<Template[]>([]);

  protected readonly upload = signal<Collected | null>(null);
  protected readonly dragging = signal(false);
  /** '' = auto. */
  protected readonly choice = signal<Detected | ''>('');
  protected readonly detected = computed<Detected>(() => detect(this.upload()?.files.map((f) => f.path) ?? [], this.list()?.detection ?? []));

  protected readonly name = signal('');
  protected readonly visibility = signal('');
  protected readonly ttl = signal('');
  protected readonly project = signal('');
  protected readonly template = signal('');
  protected readonly namePlaceholder = computed(() => this.upload() ? 'from the upload' : 'automatic, e.g. bun-k3x9');

  protected readonly busy = signal(false);
  protected readonly progress = signal<number | null>(null);
  protected readonly error = signal<ProblemError | null>(null);
  protected readonly notes = signal<string[]>([]);

  constructor() {
    // From an effect, not the constructor: the session (and so the permission) may arrive after the page.
    effect(() => {
      if (!this.canDeploy()) return;
      untracked(() => void this.#load());
    });
  }

  async #load(): Promise<void> {
    try { this.list.set(await firstValueFrom(this.#http.get<RuntimeList>('/v1/runtimes'))); }
    catch (e) { this.runtimesError.set(`Could not load runtimes: ${toProblem(e).detail}`); }
    // Optional pickers: a role that cannot list them still deploys.
    void firstValueFrom(this.#http.get<{ projects: Project[] }>('/v1/projects')).then((r) => this.projects.set(r.projects), () => {});
    void firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')).then((r) => this.templates.set(r.templates), () => {});
  }

  protected label(d: Detected): string {
    return d === 'own' ? OWN_LABEL : (this.runtimes().find((r) => r.id === d)?.name ?? d);
  }

  protected over(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(true);
  }

  protected async dropped(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.dragging.set(false);
    if (e.dataTransfer) await this.#collect(() => collectFromDrop(e.dataTransfer!));
  }

  protected async picked(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0) await this.#collect(() => collectFromFiles(files));
  }

  /** Public for tests: what a drop or a pick ends in. */
  async accept(c: Collected): Promise<void> {
    await this.#collect(() => Promise.resolve(c));
  }

  async #collect(fn: () => Promise<Collected>): Promise<void> {
    this.error.set(null); this.notes.set([]);
    try {
      const c = await fn();
      if (c.files.length === 0) throw new UploadError('Nothing to upload: no files were found (or all were skipped).');
      this.upload.set(c);
      this.choice.set('');
      if (!this.name() && c.name) this.name.set(c.name);
    } catch (err) {
      this.error.set({ status: 0, title: 'Cannot use those files', detail: err instanceof Error ? err.message : String(err), requestId: null, retryAfter: null, issues: [] });
    }
  }

  protected clear(): void {
    this.upload.set(null);
    this.choice.set('');
    this.error.set(null); this.notes.set([]);
  }

  protected startFrom(r: Runtime): Promise<void> {
    return this.#post(packStarter(r.starter), r.id);
  }

  protected deployUpload(): Promise<void> {
    const u = this.upload();
    if (!u) return Promise.resolve();
    return this.#post(packFiles(u.files), this.choice() || this.detected());
  }

  async #post(body: Blob, runtime: Detected): Promise<void> {
    this.busy.set(true);
    this.error.set(null); this.notes.set([]);
    this.progress.set(0);
    const query = deployQuery({
      runtime, name: this.name().trim(), visibility: this.visibility(), ttl: this.ttl().trim(),
      project: this.project(), template: this.template(),
    });
    try {
      const res = await firstValueFrom(this.#http.post<{ preview: Preview }>(`/v1/previews${query}`, body, {
        headers: { 'content-type': 'application/gzip' }, reportProgress: true, observe: 'events',
      }).pipe(
        tap((ev) => { if (ev.type === HttpEventType.UploadProgress && ev.total) this.progress.set(Math.round((ev.loaded / ev.total) * 100)); }),
        last(),
      ));
      if (res.type !== HttpEventType.Response || !res.body) throw new Error('The server did not answer with a preview.');
      await this.#router.navigate(['/previews', res.body.preview.id]);
    } catch (e) {
      this.error.set(toProblem(e));
      this.notes.set(problemNotes(e));
      if (toProblem(e).status === 403) void this.#auth.refresh();
    } finally {
      this.busy.set(false);
      this.progress.set(null);
    }
  }
}
