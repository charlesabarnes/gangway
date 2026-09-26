import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { InstalledRepository, PrTrigger, Project, ProjectCreate } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { issuesOrDetail, toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state';
import { StateBadge } from '../../ui/state-badge';
import { ToastService } from '../../ui/toast';
import { FIELD } from '../../ui/field';
import { PreviewsStore } from '../previews/previews.store';

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
    <section class="gw-page">
      <div class="gw-title-rule flex flex-wrap items-end gap-5">
        <div class="flex flex-col gap-2.5">
          <h1 class="gw-h1">Repositories</h1>
          <p class="m-0 font-serif text-base leading-snug text-muted">
            Connect a repository and each pull request gets its own preview, linked from a comment
            and removed when the pull request closes.
          </p>
        </div>
        @if (canManage() && !creating()) {
          <button
            appBtn
            type="button"
            class="mb-1 ml-auto"
            (click)="startCreate()"
            data-testid="new"
          >
            Connect repository
          </button>
        }
      </div>

      @if (creating()) {
        <form
          (submit)="create($event)"
          novalidate
          class="gw-neatline grid gap-5 p-6 sm:grid-cols-2"
          data-testid="create"
        >
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Repository</span>
            <input
              [class]="field"
              class="font-mono !text-sm"
              list="installed-repos"
              [value]="repository()"
              (input)="pickRepository($any($event.target).value)"
              placeholder="owner/name"
              data-testid="create-repo"
            />
            <datalist id="installed-repos">
              @for (r of installed(); track r.fullName) {
                <option [value]="r.fullName">{{ r.private ? 'private' : 'public' }}</option>
              }
            </datalist>
            <span class="text-xs text-muted">
              @if (installed().length) {
                Where the GitHub App is installed, or type any.
              } @else {
                On GitHub, as owner/name.
              }
            </span>
          </label>
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Name</span
            ><input
              [class]="field"
              [value]="name()"
              (input)="name.set($any($event.target).value)"
              placeholder="the repository's name"
              data-testid="create-name"
          /></label>
          @if (repository()) {
            <fieldset class="sm:col-span-2">
              <legend class="gw-label">Pull requests arrive through</legend>
              <div class="mt-1.5 grid gap-2 sm:grid-cols-2">
                @for (t of triggers; track t) {
                  <label
                    class="flex cursor-pointer gap-2.5 bg-surface p-3 text-sm"
                    [class]="
                      trigger() === t
                        ? 'shadow-[inset_0_0_0_1px_var(--gw-ink)]'
                        : 'shadow-[inset_0_0_0_1px_var(--gw-rule)]'
                    "
                  >
                    <input
                      type="radio"
                      name="trigger"
                      [value]="t"
                      [checked]="trigger() === t"
                      (change)="trigger.set(t)"
                      [attr.data-testid]="'create-trigger-' + t"
                      class="gw-box mt-0.5"
                    />
                    <span
                      ><span class="font-medium">{{ triggerHelp[t].name }}</span
                      ><span class="block text-xs text-muted">{{ triggerHelp[t].help }}</span></span
                    >
                  </label>
                }
              </div>
            </fieldset>
          }
          <div class="flex items-end justify-end gap-2.5 sm:col-span-2">
            @if (createError(); as e) {
              <span class="mr-auto text-sm text-danger" role="alert" data-testid="create-error">{{
                e
              }}</span>
            }
            <button appBtn variant="ghost" type="button" (click)="creating.set(false)">
              Cancel
            </button>
            <button
              appBtn
              type="submit"
              [disabled]="!repository() || busy()"
              data-testid="create-save"
            >
              Connect
            </button>
          </div>
        </form>
      }

      @if (connected().length > 0) {
        <ul class="grid gap-5 sm:grid-cols-2" data-testid="projects">
          @for (p of connected(); track p.id) {
            <li>
              <a
                [routerLink]="['/repositories', p.slug]"
                class="gw-neatline flex h-full flex-col gap-3 bg-paper p-[22px] transition hover:bg-surface"
                [class.opacity-60]="!p.enabled"
                data-testid="project"
              >
                <div class="flex items-center gap-2.5">
                  <span class="font-serif text-[26px] leading-tight">{{ p.name }}</span>
                  @if (!p.enabled) {
                    <span class="gw-tag border-danger text-danger">disabled</span>
                  }
                </div>
                <p class="m-0 font-mono text-[13px] text-muted" data-testid="source">
                  {{ p.fullName }} · {{ p.prTrigger === 'workflow' ? 'workflow' : 'GitHub App' }}
                </p>
                <ul class="flex flex-col gap-1.5 border-t border-dotted border-rule pt-3">
                  @for (pv of live(p.id); track pv.id) {
                    <li class="flex items-center gap-3 text-sm">
                      <app-state-badge class="w-[90px] shrink-0" [state]="pv.state" /><span
                        class="truncate text-xs"
                        [class.font-mono]="!pv.title"
                        >{{ pv.title ?? pv.project.replace(prefix(pv.project), '') }}</span
                      >
                    </li>
                  } @empty {
                    <li class="text-sm text-muted">No previews running.</li>
                  }
                </ul>
              </a>
            </li>
          }
        </ul>
      } @else if (loaded()) {
        <app-empty-state heading="No repositories yet">
          <p>Connect one and its pull requests get previews.</p>
        </app-empty-state>
      }

      @if (unconnected().length > 0) {
        <div class="flex flex-col gap-2">
          <h2 class="gw-label">Without a repository</h2>
          <p class="m-0 text-sm text-muted">
            Created through the API; they group previews deployed with a
            <code class="font-mono">project</code> and share their settings and secrets.
          </p>
          <ul class="border-t border-rule" data-testid="unconnected">
            @for (p of unconnected(); track p.id) {
              <li class="flex items-center gap-3.5 border-b border-rule py-2.5 text-sm">
                <a [routerLink]="['/repositories', p.slug]" class="hover:underline">{{ p.name }}</a>
                <span class="ml-auto font-mono text-xs text-muted"
                  >{{ live(p.id).length }} running</span
                >
              </li>
            }
          </ul>
        </div>
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
  protected readonly installed = signal<InstalledRepository[]>([]);
  protected readonly loaded = signal(false);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly repository = signal('');
  protected readonly trigger = signal<PrTrigger>('workflow');
  protected readonly connected = computed(() => this.projects().filter((p) => p.fullName));
  protected readonly unconnected = computed(() => this.projects().filter((p) => !p.fullName));

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
      const { projects } = await firstValueFrom(
        this.#http.get<{ projects: Project[] }>('/v1/projects'),
      );
      this.projects.set(projects);
    } catch (e) {
      this.#toasts.problem('Could not load repositories', toProblem(e));
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
  protected startCreate(): void {
    this.name.set('');
    this.repository.set('');
    this.trigger.set('workflow');
    this.createError.set(null);
    this.creating.set(true);
  }

  protected pickRepository(v: string): void {
    this.repository.set(v.trim());
    if (!this.name().trim() && v.includes('/')) this.name.set(v.split('/').pop() ?? '');
  }

  protected async create(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.repository() || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    const body: ProjectCreate = {
      name: this.name().trim() || (this.repository().split('/').pop() ?? this.repository()),
      repository: this.repository(),
      prTrigger: this.trigger(),
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
        ['/repositories', project.slug],
        project.prTrigger === 'workflow' && project.fullName
          ? { queryParams: { tab: 'workflow' } }
          : {},
      );
    } catch (err) {
      const p = toProblem(err);
      this.createError.set(issuesOrDetail(p));
    } finally {
      this.busy.set(false);
    }
  }
}
