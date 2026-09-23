import { HttpClient } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom, map } from 'rxjs';
import type { Project, ProjectPatch, Template } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from '../previews/previews.store';
import { ProjectPreviews } from './project-previews';
import { ProjectSecrets } from './project-secrets';
import { ProjectSettings } from './project-settings';
import { ProjectWorkflow } from './project-workflow';

type Tab = 'previews' | 'settings' | 'secrets' | 'workflow';

@Component({
  selector: 'app-project',
  imports: [ProjectPreviews, ProjectSecrets, ProjectSettings, ProjectWorkflow, RouterLink],
  template: `
    <section class="mx-auto max-w-5xl px-6 py-10">
      <p class="text-sm text-neutral-500">
        <a routerLink="/projects" class="hover:text-accent">Projects</a> <span class="px-1">/</span>
        {{ project()?.slug ?? ref() }}
      </p>
      @if (project(); as p) {
        <div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 class="text-2xl font-semibold tracking-tight">{{ p.name }}</h1>
          @if (!p.enabled) {
            <span
              class="rounded-full border border-amber-400 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
              >disabled</span
            >
          }
          <span class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="source"
            >{{ p.fullName ? p.fullName : 'no repository' }}
            @if (p.fullName) {
              · pull requests from
              {{ p.prTrigger === 'workflow' ? 'its workflow' : 'the GitHub App' }}
            }
          </span>
        </div>
        @if (p.disabledReason; as why) {
          <p class="mt-1 text-sm text-amber-700 dark:text-amber-400">{{ why }}</p>
        }

        <nav
          class="mt-6 flex gap-5 border-b border-neutral-200 text-sm dark:border-neutral-800"
          aria-label="Project"
        >
          @for (t of tabs(); track t.id) {
            <a
              [routerLink]="[]"
              [queryParams]="{ tab: t.id === 'previews' ? null : t.id }"
              class="-mb-px border-b-2 px-0.5 pb-2.5 font-medium"
              [class]="
                tab() === t.id
                  ? 'border-accent text-neutral-900 dark:text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
              "
              [attr.data-testid]="'tab-' + t.id"
              >{{ t.label }}</a
            >
          }
        </nav>

        @switch (tab()) {
          @case ('previews') {
            <app-project-previews [project]="p" />
          }
          @case ('settings') {
            <app-project-settings
              [project]="p"
              [templates]="templates()"
              [(draft)]="draft"
              (saved)="saved($event)"
            />
          }
          @case ('secrets') {
            <app-project-secrets [project]="p" />
          }
          @case ('workflow') {
            <app-project-workflow [project]="p" [(port)]="port" />
          }
        }
      } @else if (missing()) {
        <p class="mt-6 text-sm text-neutral-500" data-testid="missing">
          No such project.
          <a routerLink="/projects" class="text-accent hover:underline">Back to projects</a>.
        </p>
      }
    </section>
  `,
})
export class ProjectPage {
  readonly ref = input.required<string>();

  readonly #auth = inject(AuthService);
  readonly #store = inject(PreviewsStore);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly project = signal<Project | null>(null);
  protected readonly missing = signal(false);
  protected readonly templates = signal<Template[]>([]);
  protected readonly draft = signal<ProjectPatch>({});
  protected readonly port = signal(3000);

  readonly #query = toSignal(inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('tab'))), {
    initialValue: null,
  });
  protected readonly tabs = computed(() => {
    const p = this.project();
    return [
      { id: 'previews' as Tab, label: 'Previews' },
      ...(this.#auth.can('repos.manage') ? [{ id: 'settings' as Tab, label: 'Settings' }] : []),
      ...(this.#auth.can('repos.secrets') ? [{ id: 'secrets' as Tab, label: 'Secrets' }] : []),
      ...(p?.fullName && p.prTrigger === 'workflow'
        ? [{ id: 'workflow' as Tab, label: 'Workflow' }]
        : []),
    ];
  });
  protected readonly tab = computed<Tab>(() => {
    const want = this.#query();
    return this.tabs().some((t) => t.id === want) ? (want as Tab) : 'previews';
  });

  constructor() {
    this.#store.connect();
    inject(DestroyRef).onDestroy(() => this.#store.disconnect());
    effect(() => {
      const ref = this.ref();
      untracked(() => void this.#load(ref));
    });
  }

  async #load(ref: string): Promise<void> {
    try {
      const [{ project }, { templates }] = await Promise.all([
        firstValueFrom(
          this.#http.get<{ project: Project }>(`/v1/projects/${encodeURIComponent(ref)}`),
        ),
        firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')),
      ]);
      this.project.set(project);
      this.templates.set(templates);
      this.draft.set({});
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 404) this.missing.set(true);
      else this.#toasts.problem('Could not load the project', p);
    }
  }

  protected saved(project: Project): void {
    this.project.set(project);
    this.draft.set({});
  }
}
