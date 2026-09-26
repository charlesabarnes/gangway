import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ArtifactKind } from '../../core/artifact.types';
import { ARTIFACT_KINDS, KIND_LABELS, type TemplateSummary } from '../../core/artifacts.types';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactsService } from './artifacts.service';
import { THUMB } from './template-library';
import { themeCss } from './theme-css';

const KIND_HELP: Record<ArtifactKind, string> = {
  document: 'Something to read: a report, a memo, release notes, a process.',
  deck: 'Something to present: a pitch, a review, a talk.',
  canvas: 'A board to pan and zoom: screens of a flow, illustrations, a system map.',
};

/** Start an artifact from a template: pick it, name it, and gangway puts it on a URL. */
@Component({
  selector: 'app-new-artifact',
  imports: [ArtifactFrame, Btn, RouterLink],
  template: `
    <section class="gw-page !max-w-[1400px]">
      <a class="gw-back" routerLink="/artifacts">← Artifacts</a>
      <div class="gw-title-rule">
        <h1 class="gw-h1">New artifact</h1>
      </div>
      <div class="grid gap-8 lg:grid-cols-[420px_minmax(0,1fr)]">
        <form class="flex flex-col gap-6" (submit)="$event.preventDefault(); create()">
          <fieldset class="grid gap-2">
            <legend class="gw-label mb-2">Kind</legend>
            @for (k of kinds; track k) {
              <label
                class="flex cursor-pointer gap-3 p-3 text-sm"
                [class]="
                  kind() === k
                    ? 'shadow-[inset_0_0_0_1px_var(--gw-ink)]'
                    : 'shadow-[inset_0_0_0_1px_var(--gw-rule)]'
                "
              >
                <input
                  type="radio"
                  name="kind"
                  class="gw-box mt-0.5"
                  [checked]="kind() === k"
                  (change)="pickKind(k)"
                  [attr.data-testid]="'kind-' + k"
                />
                <span
                  ><span class="font-medium">{{ labels[k] }}</span
                  ><span class="block text-xs text-muted">{{ help[k] }}</span></span
                >
              </label>
            }
          </fieldset>
          <label class="gw-label flex flex-col gap-1"
            >Template
            <select
              [class]="field"
              (change)="template.set($any($event.target).value)"
              data-testid="template"
            >
              @for (t of forKind(); track t.id) {
                <option [value]="t.id" [selected]="t.id === template()">
                  {{ t.name }}{{ t.builtin ? '' : ' (made here)' }}
                </option>
              }
            </select>
            <span class="text-xs font-normal tracking-normal text-muted normal-case">{{
              chosen()?.description
            }}</span>
          </label>
          <label class="gw-label flex flex-col gap-1"
            >Title<input
              [class]="field"
              [value]="title()"
              (input)="title.set($any($event.target).value)"
              [placeholder]="'What it is about'"
              data-testid="title"
          /></label>
          <label class="gw-label flex flex-col gap-1"
            >Subtitle<input
              [class]="field"
              [value]="subtitle()"
              (input)="subtitle.set($any($event.target).value)"
              data-testid="subtitle"
          /></label>
          <div class="grid grid-cols-2 gap-4">
            <label class="gw-label flex flex-col gap-1"
              >Theme
              <select
                [class]="field"
                (change)="theme.set($any($event.target).value || null)"
                data-testid="theme"
              >
                <option value="">The default</option>
                @for (t of themes(); track t.id) {
                  <option [value]="t.id">{{ t.name }}</option>
                }
              </select></label
            >
            <label class="gw-label flex flex-col gap-1"
              >Visibility
              <select
                [class]="field"
                (change)="visibility.set($any($event.target).value)"
                data-testid="visibility"
              >
                <option value="unlisted" selected>Unlisted</option>
                <option value="public">Public</option>
                <option value="private">Signed-in only</option>
              </select></label
            >
          </div>
          @if (problem(); as e) {
            <p class="text-sm text-danger" role="alert" data-testid="problem">{{ e.detail }}</p>
          }
          <div class="flex items-center gap-4">
            <button appBtn type="submit" [disabled]="!template() || busy()" data-testid="create">
              {{ busy() ? 'Deploying…' : 'Deploy it' }}
            </button>
            <span class="text-xs text-muted"
              >Change its words afterwards on the preview's page, or ask your agent.</span
            >
          </div>
        </form>
        <div class="gw-neatline h-[70vh] p-[5px]">
          @if (files(); as f) {
            <app-artifact-frame
              class="h-full"
              [files]="f"
              [themeCss]="css()"
              [width]="width()"
              [interactive]="true"
            />
          }
        </div>
      </div>
    </section>
  `,
})
export class NewArtifact {
  readonly #svc = inject(ArtifactsService);
  readonly #router = inject(Router);
  readonly #query = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  protected readonly field = FIELD;
  protected readonly kinds = ARTIFACT_KINDS;
  protected readonly labels = KIND_LABELS;
  protected readonly help = KIND_HELP;
  protected readonly all = signal<TemplateSummary[]>([]);
  protected readonly kind = signal<ArtifactKind>('document');
  protected readonly template = signal('');
  protected readonly title = signal(this.#query().get('title') ?? '');
  protected readonly subtitle = signal('');
  protected readonly theme = signal<string | null>(null);
  protected readonly visibility = signal('unlisted');
  protected readonly files = signal<Record<string, string> | null>(null);
  protected readonly busy = signal(false);
  protected readonly problem = signal<ProblemError | null>(null);
  protected readonly themes = computed(() => this.#svc.themes()?.themes ?? []);
  protected readonly forKind = computed(() => this.all().filter((t) => t.kind === this.kind()));
  protected readonly chosen = computed(() => this.all().find((t) => t.id === this.template()));
  protected readonly width = computed(() => THUMB[this.kind()].w);
  protected readonly css = computed(() => {
    const t = this.#svc.theme(this.theme() ?? this.chosen()?.themeId ?? null);
    return t ? themeCss(t) : '';
  });

  constructor() {
    void this.#svc.loadThemes().catch(() => undefined);
    void this.#svc.templates().then((all) => {
      this.all.set(all);
      const want = all.find((t) => t.id === this.#query().get('template'));
      this.pickKind(want?.kind ?? 'document', want?.id);
    });
    effect(() => {
      const input = {
        template: this.template(),
        title: this.title(),
        subtitle: this.subtitle(),
        theme: this.theme(),
      };
      if (!input.template) return;
      untracked(() =>
        this.#svc
          .render({
            template: input.template,
            ...(input.title.trim() ? { title: input.title.trim() } : {}),
            ...(input.subtitle.trim() ? { subtitle: input.subtitle.trim() } : {}),
            ...(input.theme ? { theme: input.theme } : {}),
          })
          .then(
            (f) => this.files.set(f),
            (e: ProblemError) => this.problem.set(e),
          ),
      );
    });
  }

  protected pickKind(k: ArtifactKind, template?: string): void {
    this.kind.set(k);
    this.template.set(template ?? this.all().find((t) => t.kind === k)?.id ?? '');
  }

  protected async create(): Promise<void> {
    this.busy.set(true);
    this.problem.set(null);
    try {
      const { preview } = await this.#svc.deploy({
        template: this.template(),
        ...(this.title().trim() ? { title: this.title().trim() } : {}),
        ...(this.subtitle().trim() ? { subtitle: this.subtitle().trim() } : {}),
        ...(this.theme() ? { theme: this.theme()! } : {}),
        visibility: this.visibility(),
      });
      await this.#router.navigate(['/previews', preview.id]);
    } catch (e) {
      this.problem.set(e as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }
}
