import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Project } from '../../core/api.types';
import type { DomainListing } from '../../core/domain.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { DomainClaims } from '../domains/domain-claims';
import { PreviewsStore } from '../previews/previews.store';

/** The domain a repository's previews are named under, its own domains, and its production. */
@Component({
  selector: 'app-project-domains',
  host: { class: 'block' },
  imports: [DomainClaims],
  template: `
    @let p = project();
    <div class="flex max-w-4xl flex-col gap-6" data-testid="project-domains">
      <div class="flex flex-wrap items-end gap-6">
        <label class="gw-label min-w-56"
          >Previews named under
          <select
            [class]="field"
            [disabled]="!canManage() || saving()"
            (change)="patch({ domain: $any($event.target).value || null })"
            data-testid="project-domain"
          >
            <option value="" [selected]="p.domain === null">Follow the server</option>
            @for (d of listing()?.available ?? []; track d) {
              <option [value]="d" [selected]="d === p.domain">{{ d }}</option>
            }
          </select></label
        >
        <label class="gw-label min-w-56"
          >Production preview
          <select
            [class]="field"
            [disabled]="!canManage() || saving()"
            (change)="production($any($event.target).value || null)"
            data-testid="production"
          >
            <option value="" [selected]="p.productionPreviewId === null">None</option>
            @for (v of previews(); track v.id) {
              <option [value]="v.id" [selected]="v.id === p.productionPreviewId">
                {{ v.title ?? v.project }}
              </option>
            }
          </select></label
        >
        <p class="min-w-48 flex-1 text-sm text-muted">
          A change of domain reaches each preview on its next deploy or rebuild. The repository's
          own hostnames answer for its production preview.
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <h2 class="gw-label">Its own domains</h2>
        <p class="m-0 text-sm text-muted">
          A wildcard names this repository's previews under your domain
          (pr-12.previews.example.com); a hostname like www.example.com answers for its production
          preview.
        </p>
        <app-domain-claims
          [url]="'/v1/projects/' + p.id + '/domains'"
          [kinds]="['wildcard', 'exact']"
          [canManage]="canManage()"
          (listed)="listing.set($event)"
        />
      </div>
    </div>
  `,
})
export class ProjectDomains {
  readonly project = input.required<Project>();
  readonly saved = output<Project>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);
  readonly #store = inject(PreviewsStore);

  protected readonly field = FIELD;
  protected readonly saving = signal(false);
  protected readonly listing = signal<DomainListing | null>(null);
  protected readonly canManage = computed(() => this.#auth.can('repos.domains'));
  protected readonly previews = computed(() =>
    this.#store
      .previews()
      .filter((v) => v.projectId === this.project().id && v.state !== 'destroyed'),
  );

  protected patch(body: { domain: string | null }): Promise<void> {
    return this.#save(() =>
      firstValueFrom(
        this.#http.patch<{ project: Project }>(`/v1/projects/${this.project().id}`, body),
      ),
    );
  }

  protected production(previewId: string | null): Promise<void> {
    return this.#save(() =>
      firstValueFrom(
        this.#http.put<{ project: Project }>(`/v1/projects/${this.project().id}/production`, {
          previewId,
        }),
      ),
    );
  }

  async #save(fn: () => Promise<{ project: Project }>): Promise<void> {
    this.saving.set(true);
    try {
      const { project } = await fn();
      this.saved.emit(project);
      this.#toasts.info(`Saved ${project.name}`);
    } catch (e) {
      this.#toasts.problem('Could not save', toProblem(e));
    } finally {
      this.saving.set(false);
    }
  }
}
