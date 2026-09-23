import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type {
  InstalledRepository,
  PrTrigger,
  Project,
  ProjectCreate,
  Template,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state';
import { StateBadge } from '../../ui/state-badge';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from '../previews/previews.store';

export const FIELD =
  'block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';
export const TRIGGER_HELP: Record<PrTrigger, { name: string; help: string }> = {
  workflow: {
    name: 'A workflow in the repository',
    help: 'GitHub builds the image; gangway runs it. Recommended.',
  },
  webhook: {
    name: 'The GitHub App',
    help: 'gangway clones and builds on its own host. Needs the App installed.',
  },
};
const LIVE = new Set(['building', 'starting', 'awake', 'asleep', 'failed']);

@Component({
  selector: 'app-projects',
  imports: [Btn, EmptyState, RouterLink, StateBadge],
  template: `
    <section class="mx-auto max-w-5xl px-6 py-10">
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">Projects</h1>
          <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Each project is one thing you preview: where its code comes from, how its previews
            behave, and its secrets.
          </p>
        </div>
        @if (canManage() && !creating()) {
          <button appBtn type="button" class="ml-auto" (click)="startCreate()" data-testid="new">
            New project
          </button>
        }
      </div>

      @if (creating()) {
        <form
          (submit)="create($event)"
          novalidate
          class="mt-6 grid gap-4 rounded-lg border border-neutral-200 p-5 sm:grid-cols-2 dark:border-neutral-800"
          data-testid="create"
        >
          <label class="text-xs text-neutral-500"
            >Name<input
              [class]="field"
              [value]="name()"
              (input)="name.set($any($event.target).value)"
              placeholder="Store admin"
              data-testid="create-name"
          /></label>
          <label class="text-xs text-neutral-500"
            >Repository
            <input
              [class]="field"
              list="installed-repos"
              [value]="repository()"
              (input)="pickRepository($any($event.target).value)"
              placeholder="owner/name — blank for none"
              data-testid="create-repo"
            />
            <datalist id="installed-repos">
              @for (r of installed(); track r.fullName) {
                <option [value]="r.fullName">{{ r.private ? 'private' : 'public' }}</option>
              }
            </datalist>
            <span class="mt-1 block">
              @if (installed().length) {
                Where the GitHub App is installed, or type any.
              } @else {
                With no repository, the project takes images and tarballs from the API.
              }
            </span>
          </label>
          @if (repository()) {
            <fieldset class="sm:col-span-2">
              <legend class="text-xs text-neutral-500">Pull requests arrive through</legend>
              <div class="mt-1.5 grid gap-2 sm:grid-cols-2">
                @for (t of triggers; track t) {
                  <label
                    class="flex cursor-pointer gap-2.5 rounded-md border p-3 text-sm"
                    [class]="
                      trigger() === t
                        ? 'border-accent bg-accent/5'
                        : 'border-neutral-300 dark:border-neutral-700'
                    "
                  >
                    <input
                      type="radio"
                      name="trigger"
                      [value]="t"
                      [checked]="trigger() === t"
                      (change)="trigger.set(t)"
                      [attr.data-testid]="'create-trigger-' + t"
                      class="mt-0.5"
                    />
                    <span
                      ><span class="font-medium">{{ triggerHelp[t].name }}</span
                      ><span class="block text-xs text-neutral-500">{{
                        triggerHelp[t].help
                      }}</span></span
                    >
                  </label>
                }
              </div>
            </fieldset>
          }
          <label class="text-xs text-neutral-500"
            >Template<select
              [class]="field"
              (change)="templateId.set($any($event.target).value || null)"
              data-testid="create-template"
            >
              <option value="">the default for its trigger</option>
              @for (t of templates(); track t.id) {
                <option [value]="t.id">{{ t.name }}</option>
              }
            </select></label
          >
          <div class="flex items-end justify-end gap-2 sm:col-span-2">
            @if (createError(); as e) {
              <span
                class="mr-auto text-sm text-red-700 dark:text-red-400"
                role="alert"
                data-testid="create-error"
                >{{ e }}</span
              >
            }
            <button appBtn variant="ghost" type="button" (click)="creating.set(false)">
              Cancel
            </button>
            <button
              appBtn
              type="submit"
              [disabled]="!name().trim() || busy()"
              data-testid="create-save"
            >
              Create project
            </button>
          </div>
        </form>
      }

      @if (projects().length > 0) {
        <ul class="mt-6 grid gap-4 sm:grid-cols-2" data-testid="projects">
          @for (p of projects(); track p.id) {
            <li>
              <a
                [routerLink]="['/projects', p.slug]"
                class="block h-full rounded-lg border border-neutral-200 p-5 transition hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
                [class.opacity-60]="!p.enabled"
                data-testid="project"
              >
                <div class="flex items-center gap-2">
                  <span class="text-base font-semibold">{{ p.name }}</span>
                  @if (!p.enabled) {
                    <span
                      class="rounded-full border border-amber-400 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                      >disabled</span
                    >
                  }
                  <span
                    class="ml-auto rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
                    data-testid="template-chip"
                    >{{ templateName(p.templateId) }}</span
                  >
                </div>
                <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400" data-testid="source">
                  {{
                    p.fullName
                      ? p.fullName +
                        ' · ' +
                        (p.prTrigger === 'workflow' ? 'workflow' : 'GitHub App')
                      : 'no repository'
                  }}
                </p>
                <ul class="mt-3 space-y-1.5">
                  @for (pv of live(p.id); track pv.id) {
                    <li class="flex items-center gap-2 text-xs">
                      <app-state-badge [state]="pv.state" /><span class="truncate font-mono">{{
                        pv.project.replace(prefix(pv.project), '')
                      }}</span>
                    </li>
                  } @empty {
                    <li class="text-xs text-neutral-500">No previews running.</li>
                  }
                </ul>
              </a>
            </li>
          }
        </ul>
      } @else if (loaded()) {
        <div class="mt-6">
          <app-empty-state heading="No projects yet">
            <p>
              Make one for each thing you want previews of. Pull requests from its repository get
              URLs; nothing else does.
            </p>
          </app-empty-state>
        </div>
      }

      @if (loose().length > 0) {
        <h2 class="mt-10 text-sm font-medium text-neutral-500">Not in a project</h2>
        <ul
          class="mt-2 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
          data-testid="loose"
        >
          @for (pv of loose(); track pv.id) {
            <li class="flex items-center gap-3 px-4 py-2.5 text-sm">
              <app-state-badge [state]="pv.state" /><a
                [routerLink]="['/previews', pv.id]"
                class="font-mono text-xs hover:text-accent"
                >{{ pv.project }}</a
              ><span class="ml-auto text-xs text-neutral-500">{{ pv.source.kind }}</span>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ProjectsPage {
  protected readonly auth = inject(AuthService);
  protected readonly store = inject(PreviewsStore);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #router = inject(Router);

  protected readonly field = FIELD;
  protected readonly triggers: readonly PrTrigger[] = ['workflow', 'webhook'];
  protected readonly triggerHelp = TRIGGER_HELP;

  protected readonly canManage = computed(() => this.auth.can('repos.manage'));
  protected readonly projects = signal<Project[]>([]);
  protected readonly templates = signal<Template[]>([]);
  protected readonly installed = signal<InstalledRepository[]>([]);
  protected readonly loaded = signal(false);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly repository = signal('');
  protected readonly trigger = signal<PrTrigger>('workflow');
  protected readonly templateId = signal<string | null>(null);

  protected readonly loose = computed(() =>
    this.store.previews().filter((p) => p.projectId === null && LIVE.has(p.state)),
  );

  constructor() {
    void this.#load();
    this.store.connect();
    inject(DestroyRef).onDestroy(() => this.store.disconnect());
    effect(() => {
      if (this.canManage()) untracked(() => void this.#loadInstalled());
    });
  }

  async #load(): Promise<void> {
    try {
      const [{ projects }, { templates }] = await Promise.all([
        firstValueFrom(this.#http.get<{ projects: Project[] }>('/v1/projects')),
        firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')),
      ]);
      this.projects.set(projects);
      this.templates.set(templates);
    } catch (e) {
      this.#toasts.problem('Could not load projects', toProblem(e));
    } finally {
      this.loaded.set(true);
    }
  }

  async #loadInstalled(): Promise<void> {
    try {
      this.installed.set(
        (
          await firstValueFrom(
            this.#http.get<{ repositories: InstalledRepository[] }>('/v1/github/repositories'),
          )
        ).repositories,
      );
    } catch {
      this.installed.set([]);
    }
  }

  protected live(projectId: string) {
    return this.store.previews().filter((p) => p.projectId === projectId && LIVE.has(p.state));
  }
  protected prefix(project: string): string {
    return /^gw-[^-]+-/.exec(project)?.[0] ?? '';
  }
  protected templateName(id: string | null): string {
    return id === null
      ? 'default template'
      : (this.templates().find((t) => t.id === id)?.name ?? id);
  }

  protected startCreate(): void {
    this.name.set('');
    this.repository.set('');
    this.trigger.set('workflow');
    this.templateId.set(null);
    this.createError.set(null);
    this.creating.set(true);
  }

  protected pickRepository(v: string): void {
    this.repository.set(v.trim());
    if (!this.name().trim() && v.includes('/')) this.name.set(v.split('/').pop() ?? '');
  }

  protected async create(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.name().trim() || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    const body: ProjectCreate = {
      name: this.name().trim(),
      ...(this.repository() ? { repository: this.repository(), prTrigger: this.trigger() } : {}),
      ...(this.templateId() ? { templateId: this.templateId() } : {}),
    };
    try {
      const { project } = await firstValueFrom(
        this.#http.post<{ project: Project }>('/v1/projects', body),
      );
      this.#toasts.info(
        `Created ${project.name}`,
        project.prTrigger === 'workflow' && project.fullName
          ? 'Add the workflow to the repository to start getting previews.'
          : undefined,
      );
      await this.#router.navigate(
        ['/projects', project.slug],
        project.prTrigger === 'workflow' && project.fullName
          ? { queryParams: { tab: 'workflow' } }
          : {},
      );
    } catch (err) {
      const p = toProblem(err);
      this.createError.set(
        p.issues.length ? p.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : p.detail,
      );
    } finally {
      this.busy.set(false);
    }
  }
}
