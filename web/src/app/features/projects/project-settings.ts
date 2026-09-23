import { HttpClient } from '@angular/common/http';
import {
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  CLEARANCES,
  FORK_POLICIES,
  PR_TRIGGERS,
  type Clearance,
  type ForkPolicy,
  type Project,
  type ProjectPatch,
  type Template,
  type Visibility,
} from '../../core/api.types';
import { issuesOrDetail, toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { TRIGGER_HELP } from './projects';

const FORK_HELP: Record<ForkPolicy, string> = {
  ask: 'a collaborator comments /preview deploy',
  auto: 'built automatically, public, no secrets',
  never: 'never built',
};
const VISIBILITIES: { value: Visibility | ''; label: string }[] = [
  { value: '', label: "the template's" },
  { value: 'public', label: 'public' },
  { value: 'unlisted', label: 'unlisted' },
  { value: 'private', label: 'private' },
];
const PR_CLEARANCES: { value: Clearance | ''; label: string }[] = [
  { value: '', label: "the template's" },
  ...CLEARANCES.map((c) => ({ value: c, label: c })),
];

const savedView = (p: Project): Record<string, unknown> => ({ ...p, repository: p.fullName });

@Component({
  selector: 'app-project-settings',
  host: { class: 'block' },
  imports: [Btn, ConfirmDialog],
  template: `
    @let d = view();
    <form (submit)="save($event)" novalidate class="mt-6 space-y-8" data-testid="settings">
      <section>
        <h2 class="text-sm font-semibold">Project</h2>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          <label class="text-xs text-neutral-500"
            >Name<input
              [class]="field"
              [value]="d.name"
              (input)="edit('name', $any($event.target).value)"
              data-testid="name"
          /></label>
          <label class="text-xs text-neutral-500"
            >Preview names<input
              [class]="field + ' font-mono'"
              [value]="d.slug"
              (input)="edit('slug', $any($event.target).value)"
              data-testid="slug"
            /><span class="mt-1 block font-mono">{{ d.slug }}-pr-&lt;n&gt;</span></label
          >
          <label class="flex items-center gap-2 self-center text-sm"
            ><input
              type="checkbox"
              [checked]="d.enabled"
              (change)="edit('enabled', $any($event.target).checked)"
              data-testid="enabled"
            />Previews on</label
          >
        </div>
      </section>
      <section>
        <h2 class="text-sm font-semibold">Source</h2>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          <label class="text-xs text-neutral-500"
            >Repository<input
              [class]="field"
              [value]="d.repository ?? ''"
              placeholder="owner/name — blank for none"
              (input)="edit('repository', $any($event.target).value.trim() || null)"
              data-testid="repository"
          /></label>
          @if (d.repository) {
            <label class="text-xs text-neutral-500 sm:col-span-2"
              >Pull requests arrive through<select
                [class]="field"
                (change)="edit('prTrigger', $any($event.target).value)"
                data-testid="trigger"
              >
                @for (t of prTriggers; track t) {
                  <option [value]="t" [selected]="t === d.prTrigger">
                    {{ triggerHelp[t].name }}
                  </option>
                }
              </select>
              <span class="mt-1 block">{{ triggerHelp[d.prTrigger].help }}</span></label
            >
          }
        </div>
        @if (d.repository && d.prTrigger === 'webhook') {
          <div class="mt-3 grid gap-3 sm:grid-cols-3">
            <label class="text-xs text-neutral-500"
              >From forks<select
                [class]="field"
                (change)="edit('forks', $any($event.target).value)"
                data-testid="forks"
              >
                @for (f of forkPolicies; track f) {
                  <option [value]="f" [selected]="f === d.forks">{{ f }}</option>
                }</select
              ><span class="mt-1 block">{{ forkHelp[d.forks] }}</span></label
            >
            <label class="text-xs text-neutral-500"
              >Secrets for forks<select
                [class]="field"
                (change)="edit('forkClearance', $any($event.target).value)"
                data-testid="fork-clearance"
              >
                @for (c of clearances; track c) {
                  <option [value]="c" [selected]="c === d.forkClearance">
                    {{ c }}
                  </option>
                }
              </select></label
            >
            <label class="flex items-center gap-2 self-center text-sm"
              ><input
                type="checkbox"
                [checked]="d.drafts"
                (change)="edit('drafts', $any($event.target).checked)"
                data-testid="drafts"
              />Draft pull requests too</label
            >
          </div>
        } @else if (d.repository) {
          <p class="mt-2 text-xs text-neutral-500">
            Pull requests from forks are skipped: GitHub gives their workflow runs no OIDC token.
          </p>
        }
      </section>
      <section>
        <h2 class="text-sm font-semibold">
          Previews
          <span class="font-normal text-neutral-500"
            >— anything left at "the template's" follows the template</span
          >
        </h2>
        <div class="mt-3 grid gap-3 sm:grid-cols-4">
          <label class="text-xs text-neutral-500"
            >Template<select
              [class]="field"
              (change)="edit('templateId', $any($event.target).value || null)"
              data-testid="template"
            >
              <option value="" [selected]="d.templateId === null">
                the default for its trigger
              </option>
              @for (t of templates(); track t.id) {
                <option [value]="t.id" [selected]="t.id === d.templateId">
                  {{ t.name }}
                </option>
              }
            </select></label
          >
          <label class="text-xs text-neutral-500"
            >Visibility<select
              [class]="field"
              (change)="edit('visibility', $any($event.target).value || null)"
              data-testid="visibility"
            >
              @for (v of visibilities; track v.value) {
                <option [value]="v.value" [selected]="v.value === (d.visibility ?? '')">
                  {{ v.label }}
                </option>
              }
            </select></label
          >
          <label class="text-xs text-neutral-500"
            >Expires after<input
              [class]="field"
              placeholder="the template's"
              [value]="d.ttl ?? ''"
              (input)="edit('ttl', $any($event.target).value || null)"
              data-testid="ttl"
          /></label>
          <label class="text-xs text-neutral-500"
            >Secrets<select
              [class]="field"
              (change)="edit('prClearance', $any($event.target).value || null)"
              data-testid="pr-clearance"
            >
              @for (c of prClearances; track c.value) {
                <option [value]="c.value" [selected]="c.value === (d.prClearance ?? '')">
                  {{ c.label }}
                </option>
              }
            </select></label
          >
        </div>
      </section>
      <div class="flex items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <button appBtn type="submit" [disabled]="!dirty() || saving()" data-testid="save">
          Save
        </button>
        @if (dirty()) {
          <button
            appBtn
            variant="ghost"
            type="button"
            (click)="draft.set({})"
            data-testid="discard"
          >
            Discard
          </button>
        }
        @if (saveError(); as e) {
          <span
            class="text-sm text-red-700 dark:text-red-400"
            role="alert"
            data-testid="save-error"
            >{{ e }}</span
          >
        }
        <button
          appBtn
          variant="danger"
          type="button"
          class="ml-auto"
          (click)="dialog().open()"
          data-testid="delete"
        >
          Delete project
        </button>
      </div>
    </form>

    <app-confirm-dialog
      [heading]="'Delete ' + project().name + '?'"
      confirmLabel="Delete"
      (confirmed)="remove()"
    >
      Its settings and secrets are removed. Its running previews keep running, no longer in a
      project. Pull requests from its repository stop getting previews.
    </app-confirm-dialog>
  `,
})
export class ProjectSettings {
  readonly project = input.required<Project>();
  readonly templates = input.required<Template[]>();
  readonly draft = model.required<ProjectPatch>();
  readonly saved = output<Project>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #router = inject(Router);
  protected readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly field = FIELD;
  protected readonly triggerHelp = TRIGGER_HELP;
  protected readonly prTriggers = PR_TRIGGERS;
  protected readonly forkPolicies = FORK_POLICIES;
  protected readonly forkHelp = FORK_HELP;
  protected readonly clearances = CLEARANCES;
  protected readonly prClearances = PR_CLEARANCES;
  protected readonly visibilities = VISIBILITIES;

  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);

  protected readonly view = computed(
    () =>
      ({ ...savedView(this.project()), ...this.draft() }) as Project & {
        repository: string | null;
      },
  );
  readonly #patch = computed(() => {
    const saved = savedView(this.project());
    return Object.fromEntries(Object.entries(this.draft()).filter(([k, v]) => saved[k] !== v));
  });
  protected readonly dirty = computed(() => Object.keys(this.#patch()).length > 0);

  protected edit<K extends keyof ProjectPatch>(key: K, value: ProjectPatch[K]): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const p = this.project();
    if (!this.dirty() || this.saving()) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const { project } = await firstValueFrom(
        this.#http.patch<{ project: Project }>(`/v1/projects/${p.id}`, this.#patch()),
      );
      this.saved.emit(project);
      this.#toasts.info(`Saved ${project.name}`);
      if (project.slug !== p.slug)
        await this.#router.navigate(['/projects', project.slug], {
          queryParams: { tab: 'settings' },
          replaceUrl: true,
        });
    } catch (err) {
      this.saveError.set(issuesOrDetail(toProblem(err)));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const p = this.project();
    try {
      await firstValueFrom(this.#http.delete(`/v1/projects/${p.id}`));
      this.#toasts.info(`Deleted ${p.name}`);
      await this.#router.navigateByUrl('/projects');
    } catch (err) {
      this.#toasts.problem(`Could not delete ${p.name}`, toProblem(err));
    }
  }
}
