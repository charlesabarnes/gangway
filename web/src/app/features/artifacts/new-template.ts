import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ArtifactKind } from '../../core/artifact.types';
import { KIND_LABELS } from '../../core/artifacts.types';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { ArtifactsService } from './artifacts.service';

/** What a new template of each kind starts as, before its maker changes the files. */
const SKELETON: Record<ArtifactKind, string> = {
  document:
    '---\nkind: document\ntitle: {{title}}\nsubtitle: {{subtitle}}\n---\n\n::: callout title="In short"\nThe one thing to take away.\n:::\n\n## The first finding\nWhat you found, and why it matters.\n',
  deck: '---\nkind: deck\ntitle: {{title}}\nsubtitle: {{subtitle}}\nfooter: {{title}}\n---\n\n# {{title}}\n{{subtitle}}\n\n---\n\n## The point of this slide\n- One idea\n- In a few words\n\n---\n\n{layout=end}\n# Thank you\n',
  canvas:
    '---\nkind: canvas\ntitle: {{title}}\nlayout: row\n---\n\n{#first title="First" w=360}\nWhat happens first.\n-> second "then"\n\n---\n\n{#second title="Second" w=360}\nWhat happens next.\n',
};

/** Start a template of your own from a short skeleton; its files are edited on its page. */
@Component({
  selector: 'app-new-template',
  imports: [Btn, RouterLink],
  template: `
    <section class="gw-page">
      <a class="gw-back" routerLink="/artifacts" [queryParams]="{ tab: 'templates' }"
        >← Templates</a
      >
      <div class="gw-title-rule">
        <h1 class="gw-h1">New {{ labels[kind()].toLowerCase() }} template</h1>
      </div>
      <form
        class="grid max-w-3xl gap-5 sm:grid-cols-2"
        (submit)="$event.preventDefault(); create()"
      >
        <label class="gw-label flex flex-col gap-1"
          >Name<input
            [class]="field"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
            data-testid="tpl-name"
        /></label>
        <label class="gw-label flex flex-col gap-1"
          >Id
          <span class="flex items-baseline gap-1 font-mono text-sm normal-case"
            >{{ kind() }}/<input
              [class]="field + ' font-mono'"
              [value]="slug()"
              (input)="slug.set($any($event.target).value)"
              placeholder="team-update"
              data-testid="tpl-slug"
          /></span>
        </label>
        <p class="text-sm text-muted sm:col-span-2">
          It starts as a short {{ labels[kind()].toLowerCase() }}; change its files next. To start
          from a built-in template instead, open it and duplicate it.
        </p>
        @if (problem(); as e) {
          <p class="text-sm text-danger sm:col-span-2" role="alert">{{ e.detail }}</p>
        }
        <div class="sm:col-span-2">
          <button
            appBtn
            type="submit"
            [disabled]="!slug() || !name() || busy()"
            data-testid="tpl-create"
          >
            Create template
          </button>
        </div>
      </form>
    </section>
  `,
})
export class NewTemplate {
  readonly #svc = inject(ArtifactsService);
  readonly #router = inject(Router);
  readonly #toasts = inject(ToastService);
  readonly #query = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  protected readonly field = FIELD;
  protected readonly labels = KIND_LABELS;
  protected readonly kind = computed<ArtifactKind>(() => {
    const k = this.#query().get('kind');
    return k === 'deck' || k === 'canvas' ? k : 'document';
  });
  protected readonly name = signal('');
  protected readonly slug = signal('');
  protected readonly busy = signal(false);
  protected readonly problem = signal<ProblemError | null>(null);

  protected async create(): Promise<void> {
    this.busy.set(true);
    this.problem.set(null);
    try {
      const { template } = await this.#svc.createTemplate({
        id: `${this.kind()}/${this.slug().trim()}`,
        name: this.name().trim(),
        files: { 'artifact.md': SKELETON[this.kind()] },
      });
      this.#toasts.info(`Made ${template.name}: agents see it in the catalog now`);
      await this.#router.navigate(['/artifacts/templates', ...template.id.split('/')]);
    } catch (e) {
      this.problem.set(e as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }
}
