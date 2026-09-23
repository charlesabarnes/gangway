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
    <form (submit)="save($event)" novalidate class="flex flex-col gap-7" data-testid="settings">
      <section class="gw-section">
        <h2 class="gw-h2">Project</h2>
        <div class="grid gap-x-6 gap-y-5 sm:grid-cols-3">
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Name</span
            ><input
              [class]="field"
              [value]="d.name"
              (input)="edit('name', $any($event.target).value)"
              data-testid="name"
          /></label>
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Preview names</span
            ><input
              [class]="field + ' font-mono !text-sm'"
              [value]="d.slug"
              (input)="edit('slug', $any($event.target).value)"
              data-testid="slug"
            /><span class="font-mono text-xs text-muted">{{ d.slug }}-pr-&lt;n&gt;</span></label
          >
          <label class="flex items-center gap-2 self-center text-[15px]"
            ><input
              type="checkbox"
              class="gw-box"
              [checked]="d.enabled"
              (change)="edit('enabled', $any($event.target).checked)"
              data-testid="enabled"
            />Previews on</label
          >
        </div>
      </section>
      <section class="gw-section">
        <div class="flex flex-col gap-1">
          <h2 class="gw-h2">Source</h2>
          @if (d.repository && d.prTrigger !== 'webhook') {
            <p class="gw-section-note m-0">
              Pull requests from forks are skipped: GitHub gives their workflow runs no OIDC token.
            </p>
          }
        </div>
        <div class="flex flex-col gap-5">
          <div class="grid gap-x-6 gap-y-5 sm:grid-cols-3">
            <label class="flex flex-col gap-1"
              ><span class="gw-label">Repository</span
              ><input
                [class]="field + ' font-mono !text-sm'"
                [value]="d.repository ?? ''"
                placeholder="owner/name — blank for none"
                (input)="edit('repository', $any($event.target).value.trim() || null)"
                data-testid="repository"
            /></label>
            @if (d.repository) {
              <label class="flex flex-col gap-1 sm:col-span-2"
                ><span class="gw-label">Pull requests arrive through</span
                ><select
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
                <span class="text-xs text-muted">{{ triggerHelp[d.prTrigger].help }}</span></label
              >
            }
          </div>
          @if (d.repository && d.prTrigger === 'webhook') {
            <div class="grid gap-x-6 gap-y-5 sm:grid-cols-3">
              <label class="flex flex-col gap-1"
                ><span class="gw-label">From forks</span
                ><select
                  [class]="field"
                  (change)="edit('forks', $any($event.target).value)"
                  data-testid="forks"
                >
                  @for (f of forkPolicies; track f) {
                    <option [value]="f" [selected]="f === d.forks">{{ f }}</option>
                  }</select
                ><span class="text-xs text-muted">{{ forkHelp[d.forks] }}</span></label
              >
              <label class="flex flex-col gap-1"
                ><span class="gw-label">Secrets for forks</span
                ><select
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
              <label class="flex items-center gap-2 self-center text-[15px]"
                ><input
                  type="checkbox"
                  class="gw-box"
                  [checked]="d.drafts"
                  (change)="edit('drafts', $any($event.target).checked)"
                  data-testid="drafts"
                />Draft pull requests too</label
              >
            </div>
          }
        </div>
      </section>
      <section class="gw-section">
        <div class="flex flex-col gap-1">
          <h2 class="gw-h2">Previews</h2>
          <p class="gw-section-note m-0">Anything left at “the template’s” follows the template.</p>
        </div>
        <div class="grid gap-x-6 gap-y-5 sm:grid-cols-3">
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Template</span
            ><select
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
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Visibility</span
            ><select
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
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Expires after</span
            ><input
              [class]="field"
              placeholder="the template's"
              [value]="d.ttl ?? ''"
              (input)="edit('ttl', $any($event.target).value || null)"
              data-testid="ttl"
          /></label>
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Secrets</span
            ><select
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
      <div class="flex flex-wrap items-center gap-2.5">
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
          <span class="text-sm text-danger" role="alert" data-testid="save-error">{{ e }}</span>
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
