import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  CLEARANCES,
  VISIBILITIES,
  type Clearance,
  type Template,
  type TemplateCreate,
  type TemplatePatch,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { ToastService } from '../../ui/toast';

const FIELD =
  'block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';
const CLEARANCE_HELP: Record<Clearance, string> = {
  none: 'no .env at all',
  low: 'low only',
  standard: 'low + standard',
  high: 'everything',
};
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Templates: named preview policies. What a deploy gets unless the request,
 * its project or the stack file says otherwise. `default` is built in and can be edited
 * but never removed; Settings picks one per trigger, a project picks its own.
 */
@Component({
  selector: 'app-templates',
  imports: [Btn, ConfirmDialog, RouterLink],
  template: `
    <section class="mx-auto max-w-4xl px-6 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">Templates</h1>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        A template is what a preview gets when nothing more specific is said: its visibility, how
        long it lives, when it sleeps, which secrets it may read, and where it runs.
        <a routerLink="/settings" class="underline decoration-neutral-400 underline-offset-2"
          >Settings</a
        >
        picks one per trigger; a
        <a routerLink="/projects" class="underline decoration-neutral-400 underline-offset-2"
          >project</a
        >
        picks its own.
      </p>

      <ul
        class="mt-6 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
        data-testid="templates"
      >
        @for (t of templates(); track t.id) {
          <li class="px-4 py-4" data-testid="template">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="font-medium">{{ t.name }}</span>
              <code class="font-mono text-xs text-neutral-500">{{ t.id }}</code>
              @if (t.builtin) {
                <span
                  class="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
                  data-testid="builtin"
                  >built in</span
                >
              }
              @if (!canManage()) {
                <span class="ml-auto text-xs text-neutral-500" data-testid="summary">{{
                  summary(t)
                }}</span>
              } @else if (!t.builtin) {
                <button
                  appBtn
                  variant="ghost"
                  type="button"
                  class="ml-auto"
                  (click)="askDelete(t)"
                  data-testid="delete"
                >
                  Delete
                </button>
              }
            </div>
            @if (t.description && !canManage()) {
              <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{{ t.description }}</p>
            }
            @if (canManage()) {
              <form
                (submit)="save($event, t)"
                novalidate
                class="mt-3 grid gap-3 sm:grid-cols-6"
                [attr.data-testid]="'form-' + t.id"
              >
                <label class="text-xs text-neutral-500 sm:col-span-2"
                  >Name<input
                    [class]="field"
                    [value]="draft(t).name"
                    (input)="edit(t, 'name', $any($event.target).value)"
                    data-testid="name"
                /></label>
                <label class="text-xs text-neutral-500 sm:col-span-4"
                  >Description<input
                    [class]="field"
                    [value]="draft(t).description"
                    (input)="edit(t, 'description', $any($event.target).value)"
                    data-testid="description"
                /></label>
                <label class="text-xs text-neutral-500"
                  >Visibility<select
                    [class]="field"
                    (change)="edit(t, 'visibility', $any($event.target).value)"
                    data-testid="visibility"
                  >
                    @for (v of visibilities; track v) {
                      <option [value]="v" [selected]="v === draft(t).visibility">{{ v }}</option>
                    }
                  </select></label
                >
                <label class="text-xs text-neutral-500"
                  >TTL<input
                    [class]="field"
                    placeholder="never expires"
                    [value]="draft(t).ttl ?? ''"
                    (input)="edit(t, 'ttl', $any($event.target).value || null)"
                    data-testid="ttl"
                /></label>
                <label class="text-xs text-neutral-500"
                  >Sleep after<input
                    [class]="field"
                    placeholder="30m, or never"
                    [value]="draft(t).idleAfter"
                    (input)="edit(t, 'idleAfter', $any($event.target).value)"
                    data-testid="idle"
                /></label>
                <label class="text-xs text-neutral-500"
                  >Secrets<select
                    [class]="field"
                    (change)="edit(t, 'clearance', $any($event.target).value)"
                    data-testid="clearance"
                  >
                    @for (c of clearances; track c) {
                      <option [value]="c" [selected]="c === draft(t).clearance">{{ c }}</option>
                    }
                  </select></label
                >
                <label class="text-xs text-neutral-500 sm:col-span-2"
                  >Host<input
                    [class]="field"
                    placeholder="the scheduler's choice"
                    [value]="draft(t).hostId ?? ''"
                    (input)="edit(t, 'hostId', $any($event.target).value || null)"
                    data-testid="host"
                /></label>
                <div class="flex items-center gap-3 sm:col-span-6">
                  <button
                    appBtn
                    variant="ghost"
                    type="submit"
                    [disabled]="!dirty(t) || saving() === t.id"
                    data-testid="save"
                  >
                    Save
                  </button>
                  <span class="text-xs text-neutral-500"
                    >{{ summary(draft(t)) }}. Secrets:
                    {{ clearanceHelp[draft(t).clearance] }}.</span
                  >
                  @if (rowError()?.id === t.id) {
                    <span
                      class="text-sm text-red-700 dark:text-red-400"
                      role="alert"
                      data-testid="row-error"
                      >{{ rowError()?.message }}</span
                    >
                  }
                </div>
              </form>
            }
          </li>
        } @empty {
          <li class="px-4 py-8 text-center text-sm text-neutral-500">Loading…</li>
        }
      </ul>

      @if (canManage()) {
        <h2 class="mt-10 text-base font-semibold">New template</h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Starts as a copy of <span class="font-mono">default</span>; edit it above once it exists.
        </p>
        <form
          (submit)="create($event)"
          novalidate
          class="mt-3 flex flex-wrap items-end gap-3"
          data-testid="create"
        >
          <label class="text-xs text-neutral-500"
            >Id<input
              [class]="field"
              placeholder="staging"
              [value]="newId()"
              (input)="newId.set($any($event.target).value)"
              data-testid="new-id"
          /></label>
          <label class="text-xs text-neutral-500"
            >Name<input
              [class]="field"
              placeholder="Staging"
              [value]="newName()"
              (input)="newName.set($any($event.target).value)"
              data-testid="new-name"
          /></label>
          <button
            appBtn
            type="submit"
            [disabled]="!canCreate() || creating()"
            data-testid="new-save"
          >
            Create
          </button>
          @if (createError(); as e) {
            <span
              class="text-sm text-red-700 dark:text-red-400"
              role="alert"
              data-testid="create-error"
              >{{ e }}</span
            >
          }
        </form>
      }

      <app-confirm-dialog
        [heading]="'Delete ' + (pendingDelete()?.name ?? '') + '?'"
        confirmLabel="Delete"
        (confirmed)="deleteConfirmed()"
      >
        Projects on it go back to the default for their trigger. Running previews keep what they
        were deployed with.
      </app-confirm-dialog>
    </section>
  `,
})
export class TemplatesPage {
  protected readonly auth = inject(AuthService);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  // `viewChild` cannot sit on an ES #private member (NG1053), hence TypeScript `private`.
  private readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly field = FIELD;
  protected readonly visibilities = VISIBILITIES;
  protected readonly clearances = CLEARANCES;
  protected readonly clearanceHelp = CLEARANCE_HELP;

  protected readonly canManage = computed(() => this.auth.can('templates.manage'));
  protected readonly templates = signal<Template[]>([]);
  protected readonly drafts = signal<Record<string, TemplatePatch>>({});
  protected readonly saving = signal<string | null>(null);
  protected readonly rowError = signal<{ id: string; message: string } | null>(null);
  protected readonly pendingDelete = signal<Template | null>(null);
  protected readonly newId = signal('');
  protected readonly newName = signal('');
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected readonly canCreate = computed(
    () => ID_RE.test(this.newId()) && this.newName().trim() !== '',
  );

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      this.templates.set(
        (await firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')))
          .templates,
      );
    } catch (e) {
      this.#toasts.problem('Could not load templates', toProblem(e));
    }
  }

  /** One line a person can read: "unlisted · lives 7d · sleeps after 30m · host local". */
  protected summary(t: Pick<Template, 'visibility' | 'ttl' | 'idleAfter' | 'hostId'>): string {
    return [
      t.visibility,
      t.ttl === null ? 'never expires' : `lives ${t.ttl}`,
      t.idleAfter === 'never' ? 'never sleeps' : `sleeps after ${t.idleAfter}`,
      ...(t.hostId ? [`host ${t.hostId}`] : []),
    ].join(' · ');
  }

  protected draft(t: Template): Template {
    return { ...t, ...this.drafts()[t.id] };
  }

  protected dirty(t: Template): boolean {
    const d = this.drafts()[t.id];
    return d !== undefined && Object.entries(d).some(([k, v]) => t[k as keyof TemplatePatch] !== v);
  }

  protected edit<K extends keyof TemplatePatch>(
    t: Template,
    key: K,
    value: TemplatePatch[K],
  ): void {
    this.drafts.update((all) => ({ ...all, [t.id]: { ...all[t.id], [key]: value } }));
  }

  protected async save(e: Event, t: Template): Promise<void> {
    e.preventDefault();
    const patch = this.drafts()[t.id];
    if (!patch || !this.dirty(t) || this.saving()) return;
    this.saving.set(t.id);
    this.rowError.set(null);
    try {
      const { template } = await firstValueFrom(
        this.#http.patch<{ template: Template }>(`/v1/templates/${t.id}`, patch),
      );
      this.templates.update((ts) => ts.map((x) => (x.id === template.id ? template : x)));
      this.drafts.update((all) => {
        const { [t.id]: _gone, ...rest } = all;
        return rest;
      });
      this.#toasts.info(
        `Saved ${template.name}`,
        'New previews follow it; running ones keep what they had.',
      );
    } catch (err) {
      const p = toProblem(err);
      this.rowError.set({
        id: t.id,
        message: p.issues.length
          ? p.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
          : p.detail,
      });
    } finally {
      this.saving.set(null);
    }
  }

  protected async create(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.canCreate() || this.creating()) return;
    this.creating.set(true);
    this.createError.set(null);
    const body: TemplateCreate = { id: this.newId(), name: this.newName().trim() };
    try {
      const { template } = await firstValueFrom(
        this.#http.post<{ template: Template }>('/v1/templates', body),
      );
      this.templates.update((ts) => [...ts, template]);
      this.newId.set('');
      this.newName.set('');
      this.#toasts.info(`Created ${template.name}`);
    } catch (err) {
      this.createError.set(toProblem(err).detail);
    } finally {
      this.creating.set(false);
    }
  }

  protected askDelete(t: Template): void {
    this.pendingDelete.set(t);
    this.dialog().open();
  }

  protected async deleteConfirmed(): Promise<void> {
    const t = this.pendingDelete();
    if (!t) return;
    try {
      await firstValueFrom(this.#http.delete(`/v1/templates/${t.id}`));
      this.templates.update((ts) => ts.filter((x) => x.id !== t.id));
      this.#toasts.info(`Deleted ${t.name}`);
    } catch (err) {
      this.#toasts.problem(`Could not delete ${t.name}`, toProblem(err));
    } finally {
      this.pendingDelete.set(null);
    }
  }
}
