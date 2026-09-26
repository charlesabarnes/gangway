import { Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ArtifactKind } from '../../core/artifact.types';
import { KIND_LABELS, type OptionValue, type TemplateSummary } from '../../core/artifacts.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { CodeEditor } from '../previews/code-editor';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactsService } from './artifacts.service';
import { THUMB } from './template-library';
import { TemplateOptions } from './template-options';
import { themeCss } from './theme-css';

type Files = Record<string, string>;

/** One template: drawn large, its options or its files, and what you can do with it. */
@Component({
  selector: 'app-template-detail',
  imports: [ArtifactFrame, Btn, CodeEditor, ConfirmDialog, RouterLink, TemplateOptions],
  template: `
    <section class="gw-page !max-w-[1400px]">
      <a class="gw-back" routerLink="/artifacts" [queryParams]="{ tab: 'templates' }"
        >← Templates</a
      >
      @if (summary(); as t) {
        <div class="gw-title-rule flex flex-wrap items-end gap-5">
          <div class="flex flex-col gap-2">
            <span class="gw-label"
              >{{ labels[t.kind] }} · {{ t.builtin ? 'built in' : 'made here' }} ·
              <span class="font-mono normal-case">{{ t.id }}</span></span
            >
            <h1 class="gw-h1">{{ t.name }}</h1>
            <p class="m-0 max-w-[70ch] font-serif text-base text-muted">{{ t.description }}</p>
          </div>
          <div class="mb-1 ml-auto flex flex-wrap gap-2.5">
            @if (canDeploy()) {
              <a
                appBtn
                routerLink="/artifacts/new"
                [queryParams]="{ template: t.id, title: title() || null }"
                data-testid="use-template"
                >Use this template</a
              >
            }
            @if (canManage()) {
              <button
                appBtn
                variant="ghost"
                type="button"
                (click)="duplicating.set(!duplicating())"
                data-testid="duplicate"
              >
                Duplicate to customise
              </button>
            }
          </div>
        </div>

        @if (duplicating()) {
          <form
            class="gw-neatline grid gap-5 p-6 sm:grid-cols-3"
            (submit)="$event.preventDefault(); duplicate()"
          >
            <label class="gw-label flex flex-col gap-1"
              >Name<input
                [class]="field"
                [value]="name()"
                (input)="name.set($any($event.target).value)"
                data-testid="dup-name"
            /></label>
            <label class="gw-label flex flex-col gap-1"
              >Id
              <span class="flex items-baseline gap-1 font-mono text-sm normal-case"
                >{{ t.kind }}/<input
                  [class]="field + ' font-mono'"
                  [value]="slug()"
                  (input)="slug.set($any($event.target).value)"
                  data-testid="dup-slug"
              /></span>
            </label>
            <div class="flex items-end">
              <button
                appBtn
                type="submit"
                [disabled]="!slug() || !name() || busy()"
                data-testid="dup-save"
              >
                Duplicate
              </button>
            </div>
            <p class="text-sm text-muted sm:col-span-3">
              The copy keeps the files as they are drawn now, with these options, and appears to
              agents in the catalog.
            </p>
            @if (problem(); as e) {
              <p class="text-sm text-danger sm:col-span-3" role="alert">{{ e.detail }}</p>
            }
          </form>
        }

        <div class="grid gap-8 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside class="flex flex-col gap-5">
            <label class="gw-label flex flex-col gap-1"
              >Title<input
                [class]="field"
                [value]="title()"
                (input)="title.set($any($event.target).value)"
                placeholder="the template's own"
                data-testid="opt-title"
            /></label>
            <label class="gw-label flex flex-col gap-1"
              >Theme
              <select
                [class]="field"
                (change)="themeId.set($any($event.target).value || null)"
                data-testid="opt-theme"
              >
                <option value="" [selected]="themeId() === null">The default</option>
                @for (th of themes(); track th.id) {
                  <option [value]="th.id" [selected]="th.id === themeId()">{{ th.name }}</option>
                }
              </select></label
            >
            <app-template-options
              [options]="t.options"
              [values]="options()"
              (changed)="setOpt($event.key, $event.value)"
            />
            @if (!t.builtin && canManage()) {
              <div class="flex flex-col gap-2 border-t border-dotted border-rule pt-5">
                <label class="gw-label flex flex-col gap-1"
                  >Name<input
                    [class]="field"
                    [value]="name()"
                    (input)="name.set($any($event.target).value)"
                    data-testid="edit-name"
                /></label>
                <label class="gw-label flex flex-col gap-1"
                  >Description<input
                    [class]="field"
                    [value]="description()"
                    (input)="description.set($any($event.target).value)"
                /></label>
                <div class="mt-2 flex gap-2.5">
                  <button
                    appBtn
                    type="button"
                    [disabled]="busy()"
                    (click)="save()"
                    data-testid="save-template"
                  >
                    Save
                  </button>
                  <button
                    appBtn
                    variant="danger"
                    type="button"
                    (click)="confirm().open()"
                    data-testid="delete-template"
                  >
                    Delete
                  </button>
                </div>
                @if (problem(); as e) {
                  <p class="text-sm text-danger" role="alert" data-testid="template-problem">
                    {{ e.detail }}
                  </p>
                }
              </div>
            }
          </aside>

          <div class="flex min-w-0 flex-col gap-3">
            <div class="flex items-center gap-4">
              <span class="gw-label">Preview</span>
              <button
                type="button"
                class="gw-action ml-auto"
                (click)="dark.set(!dark())"
                data-testid="preview-mode"
              >
                {{ dark() ? 'Light' : 'Dark' }}
              </button>
            </div>
            <div class="gw-neatline h-[72vh] p-[5px]">
              @if (preview(); as f) {
                <app-artifact-frame
                  class="h-full"
                  [files]="f"
                  [themeCss]="css()"
                  [mode]="dark() ? 'dark' : 'light'"
                  [width]="width()"
                  [interactive]="true"
                />
              }
            </div>
            @if (!t.builtin && canManage()) {
              <div class="flex flex-wrap items-center gap-3" role="tablist" aria-label="Files">
                @for (p of paths(); track p) {
                  <button
                    type="button"
                    role="tab"
                    class="font-mono text-xs"
                    [class]="
                      p === path()
                        ? 'text-ink underline decoration-flag decoration-2 underline-offset-4'
                        : 'text-muted'
                    "
                    [attr.aria-selected]="p === path()"
                    (click)="path.set(p)"
                  >
                    {{ p }}
                  </button>
                }
              </div>
              @defer (on idle) {
                <app-code-editor
                  [path]="path()"
                  [value]="draft()[path()] ?? ''"
                  (changed)="edit($event)"
                  (save)="save()"
                />
              } @placeholder {
                <div class="gw-skeleton h-80" data-testid="editor-loading"></div>
              }
            }
          </div>
        </div>

        <app-confirm-dialog
          [heading]="'Delete ' + t.name + '?'"
          confirmLabel="Delete"
          (confirmed)="remove()"
        >
          Agents and people can no longer start from it. Artifacts made from it are not changed.
        </app-confirm-dialog>
      } @else if (problem(); as e) {
        <p class="text-sm text-danger" role="alert">{{ e.detail }}</p>
      }
    </section>
  `,
})
export class TemplateDetail {
  readonly #svc = inject(ArtifactsService);
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);
  readonly #toasts = inject(ToastService);
  readonly #params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  protected readonly confirm = viewChild.required(ConfirmDialog);
  protected readonly field = FIELD;
  protected readonly labels = KIND_LABELS;

  readonly #id = computed(() => `${this.#params().get('kind')}/${this.#params().get('slug')}`);

  protected readonly summary = signal<TemplateSummary | null>(null);
  protected readonly draft = signal<Files>({});
  protected readonly rendered = signal<Files | null>(null);
  protected readonly path = signal('artifact.md');
  protected readonly options = signal<Record<string, OptionValue>>({});
  protected readonly title = signal('');
  protected readonly themeId = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly slug = signal('');
  protected readonly description = signal('');
  protected readonly dark = signal(false);
  protected readonly busy = signal(false);
  protected readonly duplicating = signal(false);
  protected readonly problem = signal<ProblemError | null>(null);

  protected readonly canManage = computed(() => this.#auth.can('artifacts.manage'));
  protected readonly canDeploy = computed(
    () => this.#auth.can('previews.deploy') || this.#auth.can('previews.deploy_static'),
  );
  protected readonly themes = computed(() => this.#svc.themes()?.themes ?? []);
  protected readonly paths = computed(() => Object.keys(this.draft()).sort());
  protected readonly width = computed(() => THUMB[this.summary()?.kind ?? 'document'].w);
  protected readonly css = computed(() => {
    const t = this.#svc.theme(this.themeId() ?? this.summary()?.themeId ?? null);
    return t ? themeCss(t) : '';
  });
  /** A built-in is drawn by the server with the options; your own straight from the editor. */
  protected readonly preview = computed<Files | null>(() => {
    const t = this.summary();
    if (!t) return null;
    if (t.builtin) return this.rendered();
    const title = this.title() || t.name;
    return Object.fromEntries(
      Object.entries(this.draft()).map(([p, s]) => [
        p,
        s.replaceAll('{{title}}', title).replaceAll('{{subtitle}}', ''),
      ]),
    );
  });

  constructor() {
    if (!this.#svc.themes()) void this.#svc.loadThemes().catch(() => undefined);
    effect(() => {
      const id = this.#id();
      untracked(() => void this.#load(id));
    });
    effect(() => {
      const t = this.summary();
      const input = { title: this.title(), options: this.options(), theme: this.themeId() };
      if (!t?.builtin) return;
      untracked(() =>
        this.#svc
          .render({
            template: t.id,
            ...(input.title ? { title: input.title } : {}),
            ...(input.theme ? { theme: input.theme } : {}),
            options: input.options,
          })
          .then(
            (f) => this.rendered.set(f),
            (e: ProblemError) => this.problem.set(e),
          ),
      );
    });
  }

  async #load(id: string): Promise<void> {
    try {
      const { template, files } = await this.#svc.template(id);
      this.summary.set(template);
      this.draft.set(files);
      this.rendered.set(files);
      this.name.set(template.builtin ? `${template.name} (ours)` : template.name);
      this.slug.set(template.builtin ? `${id.split('/')[1]}-ours` : '');
      this.description.set(template.description);
      this.themeId.set(template.themeId);
    } catch (e) {
      this.problem.set(e as ProblemError);
    }
  }

  protected setOpt(key: string, v: OptionValue): void {
    this.options.update((o) => ({ ...o, [key]: v }));
  }

  protected edit(text: string): void {
    this.draft.update((d) => ({ ...d, [this.path()]: text }));
  }

  protected async duplicate(): Promise<void> {
    const t = this.summary();
    const files = this.rendered();
    if (t && files) await this.#make(files, t.kind);
  }

  async #make(files: Files, kind: ArtifactKind): Promise<void> {
    this.busy.set(true);
    this.problem.set(null);
    try {
      const { template } = await this.#svc.createTemplate({
        id: `${kind}/${this.slug().trim()}`,
        name: this.name().trim(),
        description: this.description().trim() || undefined,
        themeId: this.themeId(),
        files,
      });
      this.#toasts.info(`Made ${template.name}: agents see it in the catalog now`);
      this.duplicating.set(false);
      await this.#router.navigate(['/artifacts/templates', ...template.id.split('/')]);
    } catch (e) {
      this.problem.set(e as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }

  protected async save(): Promise<void> {
    const t = this.summary();
    if (!t || t.builtin) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      const r = await this.#svc.updateTemplate(t.id, {
        name: this.name().trim(),
        description: this.description().trim(),
        themeId: this.themeId(),
        files: this.draft(),
      });
      this.summary.set(r.template);
      this.#toasts.info(`Saved ${r.template.name}`);
    } catch (e) {
      this.problem.set(e as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const t = this.summary();
    if (!t) return;
    try {
      await this.#svc.deleteTemplate(t.id);
      this.#toasts.info(`Deleted ${t.name}`);
      await this.#router.navigate(['/artifacts'], { queryParams: { tab: 'templates' } });
    } catch (e) {
      this.problem.set(e as ProblemError);
    }
  }
}
