import { HttpClient } from '@angular/common/http';
import { Component, inject, input, model, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Project, SecretTargets } from '../../core/api.types';

/** Where a connection or token with the secrets scope may set them. */
@Component({
  selector: 'app-secret-targets',
  template: `
    <fieldset class="mt-3 border-l-2 border-rule pl-4" data-testid="secret-targets">
      <legend class="gw-label">Where it may set secrets</legend>
      <div class="mt-2 flex flex-col gap-2 text-sm leading-snug">
        <label class="flex items-start gap-2.5">
          <input
            type="radio"
            class="mt-[3px]"
            name="secret-previews"
            [checked]="value().previews === 'own'"
            [disabled]="disabled()"
            (change)="patch({ previews: 'own' })"
            data-testid="targets-own"
          />
          <span>Previews it deploys itself</span>
        </label>
        <label class="flex items-start gap-2.5">
          <input
            type="radio"
            class="mt-[3px]"
            name="secret-previews"
            [checked]="value().previews === 'all'"
            [disabled]="disabled()"
            (change)="patch({ previews: 'all' })"
            data-testid="targets-all-previews"
          />
          <span>Any preview it may rebuild</span>
        </label>
        <div [class.opacity-50]="!wide()">
          <label class="flex items-start gap-2.5">
            <input
              type="checkbox"
              class="gw-box mt-[3px]"
              [checked]="value().projects === 'all'"
              [disabled]="disabled() || !wide()"
              (change)="patch({ projects: $any($event.target).checked ? 'all' : [] })"
              data-testid="targets-all-projects"
            />
            <span>Every repository's secrets</span>
          </label>
          @if (value().projects !== 'all' && projects().length > 0) {
            <div class="mt-1 ml-6 flex flex-col gap-1">
              <span class="text-xs text-muted">or these repositories:</span>
              @for (p of projects(); track p.id) {
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    class="gw-box"
                    [checked]="picked(p.id)"
                    [disabled]="disabled() || !wide()"
                    (change)="pick(p.id, $any($event.target).checked)"
                    [attr.data-testid]="'targets-project-' + p.slug"
                  />
                  <span class="font-mono text-xs">{{ p.fullName ?? p.slug }}</span>
                </label>
              }
            </div>
          }
          <label class="mt-1 flex items-start gap-2.5">
            <input
              type="checkbox"
              class="gw-box mt-[3px]"
              [checked]="value().org"
              [disabled]="disabled() || !wide()"
              (change)="patch({ org: $any($event.target).checked })"
              data-testid="targets-org"
            />
            <span>Org-wide secrets, which every preview may get</span>
          </label>
          @if (!wide()) {
            <p class="mt-1 text-xs text-muted">
              Repository and org secrets need a role that may set them.
            </p>
          }
        </div>
        <p class="text-xs text-muted">
          It can list names and set or remove values; it never reads one back.
        </p>
      </div>
    </fieldset>
  `,
})
export class SecretTargetsPicker {
  readonly value = model.required<SecretTargets>();
  readonly disabled = input(false);
  /** Whether the person may hand over repository and org secrets. */
  readonly wide = input(false);
  readonly #http = inject(HttpClient);
  protected readonly projects = signal<Project[]>([]);

  constructor() {
    void this.#load(); // NOSONAR the load starts with the component; moving it to ngOnInit changes its timing
  }

  async #load(): Promise<void> {
    try {
      const { projects } = await firstValueFrom(
        this.#http.get<{ projects: Project[] }>('/v1/projects'),
      );
      this.projects.set(projects);
    } catch {
      // Without previews.read the list is not ours to show; "every repository" still is.
    }
  }

  protected patch(p: Partial<SecretTargets>): void {
    this.value.update((v) => ({ ...v, ...p }));
  }

  protected picked(id: string): boolean {
    const p = this.value().projects;
    return p !== 'all' && p.includes(id);
  }

  protected pick(id: string, on: boolean): void {
    const p = this.value().projects;
    const list = p === 'all' ? [] : p.filter((x) => x !== id);
    this.patch({ projects: on ? [...list, id] : list });
  }
}

/** One line on where a credential may set secrets, for the token and connection lists. */
export function describeTargets(t: SecretTargets | null): string {
  if (!t) return '';
  const parts = [t.previews === 'own' ? 'its own previews' : 'previews it may rebuild'];
  if (t.projects === 'all') parts.push('every repository');
  else if (t.projects.length > 0)
    parts.push(`${t.projects.length} repositor${t.projects.length === 1 ? 'y' : 'ies'}`);
  if (t.org) parts.push('org-wide');
  return `secrets on ${parts.join(', ')}`;
}
