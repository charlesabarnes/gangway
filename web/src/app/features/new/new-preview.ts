import { HttpClient, HttpEventType } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, last, tap } from 'rxjs';
import type {
  AddonId,
  AppPlan,
  Detected,
  Preview,
  Project,
  Runtime,
  RuntimeId,
  RuntimeList,
  Template,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { localProblem, toProblem, type ProblemError } from '../../core/problem';
import { ErrorAlert } from '../../ui/error-alert';
import { AddonPicker } from './addon-picker';
import {
  choosesPassword,
  DeployOptionsForm,
  NO_OPTIONS,
  optionsQuery,
  type DeployOptions,
} from './deploy-options';
import { DropPrompt } from './drop-prompt';
import {
  collectFromDrop,
  collectFromFiles,
  detect,
  packFiles,
  packStarter,
  planPayload,
  UploadError,
  type Collected,
} from './pack';
import { RuntimeStarters } from './runtime-starters';
import { UploadSummary } from './upload-summary';
import { problemNotes } from './upload';

@Component({
  selector: 'app-new-preview',
  imports: [
    AddonPicker,
    DeployOptionsForm,
    DropPrompt,
    ErrorAlert,
    RouterLink,
    RuntimeStarters,
    UploadSummary,
  ],
  template: `
    <section class="mx-auto max-w-5xl px-6 py-10">
      <a
        routerLink="/previews"
        class="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >← Previews</a
      >
      <h1 class="mt-4 text-2xl font-semibold tracking-tight">New preview</h1>

      @if (!canDeploy()) {
        <p class="mt-6 text-sm text-neutral-600 dark:text-neutral-400" data-testid="no-permission">
          Your role cannot deploy previews. Ask an administrator for
          <code class="font-mono text-xs">previews.deploy</code>.
        </p>
      } @else {
        <app-runtime-starters
          [runtimes]="runtimes()"
          [busy]="busy()"
          [starting]="starting()"
          [error]="runtimesError()"
          (start)="startFrom($event)"
        />

        <div
          (dragover)="over($event)"
          (dragleave)="dragging.set(false)"
          (drop)="dropped($event)"
          data-testid="dropzone"
          class="mt-6 rounded-lg border-2 border-dashed px-6 py-10 text-center transition"
          [class]="
            dragging() ? 'border-accent bg-accent/5' : 'border-neutral-300 dark:border-neutral-700'
          "
        >
          @if (upload(); as u) {
            <app-upload-summary
              [upload]="u"
              [detected]="detected()"
              [runtimes]="runtimes()"
              [plan]="plan()"
              [planning]="planning()"
              [busy]="busy()"
              [(choice)]="choice"
              (deploy)="deployUpload()"
              (clear)="clear()"
            />
          } @else {
            <app-drop-prompt (picked)="picked($event)" />
          }
        </div>

        @if (addons().length > 0) {
          <app-addon-picker
            [addons]="addons()"
            [checks]="addonChecks()"
            [suggested]="autoPlan()?.suggested ?? []"
            (toggled)="toggleAddon($event.id, $event.on)"
          />
        }

        <app-deploy-options
          [(options)]="options"
          [projects]="projects()"
          [templates]="templates()"
          [namePlaceholder]="upload() ? 'from the upload' : 'automatic, e.g. bun-k3x9'"
        />

        @if (progress() !== null) {
          <div class="mt-6" data-testid="progress">
            <div class="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div class="h-full bg-accent transition-all" [style.width.%]="progress()"></div>
            </div>
            <p class="mt-1 text-xs text-neutral-500">Uploading… {{ progress() }}%</p>
          </div>
        }

        @if (error(); as e) {
          <app-error-alert
            class="mt-6 px-4 py-3"
            [problem]="e"
            [heading]="e.title"
            data-testid="error"
          >
            @if (notes().length > 0) {
              <ul
                class="mt-2 list-disc space-y-1 pl-5 font-mono text-xs whitespace-pre-wrap"
                data-testid="notes"
              >
                @for (n of notes(); track $index) {
                  <li>{{ n }}</li>
                }
              </ul>
            }
          </app-error-alert>
        }
      }
    </section>
  `,
})
export class NewPreview {
  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  protected readonly canDeploy = computed(() => this.#auth.can('previews.deploy'));
  protected readonly list = signal<RuntimeList | null>(null);
  protected readonly runtimes = computed(() => this.list()?.runtimes ?? []);
  protected readonly runtimesError = signal<string | null>(null);
  protected readonly projects = signal<Project[]>([]);
  protected readonly templates = signal<Template[]>([]);
  protected readonly starting = signal<RuntimeId | null>(null);

  protected readonly upload = signal<Collected | null>(null);
  protected readonly dragging = signal(false);
  protected readonly choice = signal<Detected | ''>('');
  protected readonly plan = signal<AppPlan | null>(null);
  protected readonly planning = signal(false);
  protected readonly autoPlan = signal<AppPlan | null>(null);
  protected readonly detected = computed<Detected>(() => {
    const auto = this.autoPlan();
    if (auto) return auto.kind === 'own' ? 'own' : (auto.runtime ?? 'static');
    return detect(this.upload()?.files.map((f) => f.path) ?? [], this.list()?.detection ?? []);
  });
  #planSeq = 0;

  protected readonly addons = computed(() => this.list()?.addons ?? []);
  protected readonly addonChecks = signal<AddonId[]>([]);
  readonly #addonsTouched = signal(false);

  protected readonly options = signal<DeployOptions>(NO_OPTIONS);
  protected readonly busy = signal(false);
  protected readonly progress = signal<number | null>(null);
  protected readonly error = signal<ProblemError | null>(null);
  protected readonly notes = signal<string[]>([]);

  constructor() {
    effect(() => {
      if (!this.canDeploy()) return;
      untracked(() => void this.#load());
    });
    effect(() => {
      const u = this.upload(),
        choice = this.choice(),
        list = this.list();
      const addons = this.#addonsTouched() ? this.addonChecks() : null;
      if (!u || !list) return;
      untracked(() => void this.#plan(u, choice, list.planFiles ?? [], addons));
    });
  }

  protected toggleAddon(id: AddonId, on: boolean): void {
    this.#addonsTouched.set(true);
    const next = this.addonChecks().filter((a) => a !== id);
    this.addonChecks.set(on ? [...next, id] : next);
  }

  #addonsParam(): string | undefined {
    const checks = this.addonChecks();
    if (checks.length > 0) return checks.join(',');
    return this.#addonsTouched() ? 'none' : undefined;
  }

  async #plan(
    u: Collected,
    choice: Detected | '',
    planFiles: readonly string[],
    addons: AddonId[] | null,
  ): Promise<void> {
    const seq = ++this.#planSeq;
    this.planning.set(true);
    this.plan.set(null);
    try {
      const body = {
        ...planPayload(u.files, planFiles),
        runtime: choice || 'auto',
        ...(addons ? { addons } : {}),
      };
      const p = await firstValueFrom(this.#http.post<AppPlan>('/v1/runtimes/plan', body));
      if (seq !== this.#planSeq) return;
      this.plan.set(p);
      if (choice === '' && !addons) this.autoPlan.set(p);
      if (!this.#addonsTouched())
        this.addonChecks.set([
          ...new Set([...p.addons.map((a) => a.id), ...p.suggested.map((s) => s.id)]),
        ]);
    } catch {
      // The plan is advice; a deploy still gets the server's own answer.
    } finally {
      if (seq === this.#planSeq) this.planning.set(false);
    }
  }

  async #load(): Promise<void> {
    try {
      this.list.set(await firstValueFrom(this.#http.get<RuntimeList>('/v1/runtimes')));
    } catch (e) {
      this.runtimesError.set(`Could not load runtimes: ${toProblem(e).detail}`);
    }
    void firstValueFrom(this.#http.get<{ projects: Project[] }>('/v1/projects')).then(
      (r) => this.projects.set(r.projects),
      () => {},
    );
    void firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')).then(
      (r) => this.templates.set(r.templates),
      () => {},
    );
  }

  protected over(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(true);
  }

  protected async dropped(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.dragging.set(false);
    const dt = e.dataTransfer;
    if (dt) await this.#collect(() => collectFromDrop(dt));
  }

  protected picked(files: File[]): Promise<void> {
    return this.#collect(() => collectFromFiles(files));
  }

  async #collect(fn: () => Promise<Collected>): Promise<void> {
    this.error.set(null);
    this.notes.set([]);
    try {
      const c = await fn();
      if (c.files.length === 0)
        throw new UploadError('Nothing to upload: no files were found (or all were skipped).');
      this.autoPlan.set(null);
      this.#addonsTouched.set(false);
      this.addonChecks.set([]);
      this.upload.set(c);
      this.choice.set('');
      const name = c.name;
      if (!this.options().name && name) this.options.update((o) => ({ ...o, name }));
    } catch (err) {
      this.error.set(localProblem('Cannot use those files', err));
    }
  }

  protected clear(): void {
    this.upload.set(null);
    this.plan.set(null);
    this.autoPlan.set(null);
    this.choice.set('');
    this.error.set(null);
    this.notes.set([]);
  }

  protected async startFrom(r: Runtime): Promise<void> {
    this.starting.set(r.id);
    try {
      await this.#post(packStarter(r.starter), r.id);
    } finally {
      this.starting.set(null);
    }
  }

  protected deployUpload(): Promise<void> {
    const u = this.upload();
    if (!u) return Promise.resolve();
    return this.#post(packFiles(u.files), this.choice() || 'auto');
  }

  async #post(body: Blob, runtime: Detected | 'auto'): Promise<void> {
    const o = this.options();
    const chosen = choosesPassword(o);
    if (chosen && o.passwordValue === '') {
      this.error.set(
        localProblem('No password', 'Type the preview password, or pick another option.', 422),
      );
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.notes.set([]);
    this.progress.set(0);
    const query = optionsQuery(o, runtime, this.#addonsParam());
    const headers: Record<string, string> = { 'content-type': 'application/gzip' };
    if (chosen) headers['gangway-preview-password'] = o.passwordValue;
    try {
      const preview = await this.#upload(`/v1/previews${query}`, body, headers);
      await this.#router.navigate(['/previews', preview.id]);
    } catch (e) {
      this.error.set(toProblem(e));
      this.notes.set(problemNotes(e));
      if (toProblem(e).status === 403) void this.#auth.refresh();
    } finally {
      this.busy.set(false);
      this.progress.set(null);
    }
  }

  async #upload(url: string, body: Blob, headers: Record<string, string>): Promise<Preview> {
    const res = await firstValueFrom(
      this.#http
        .post<{ preview: Preview }>(url, body, { headers, reportProgress: true, observe: 'events' })
        .pipe(
          tap((ev) => {
            if (ev.type === HttpEventType.UploadProgress && ev.total)
              this.progress.set(Math.round((ev.loaded / ev.total) * 100));
          }),
          last(),
        ),
    );
    if (res.type !== HttpEventType.Response || !res.body)
      throw new Error('The server did not answer with a preview.');
    return res.body.preview;
  }
}
