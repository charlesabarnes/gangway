import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { Btn } from '../../ui/button';
import { ArtifactGallery } from './gallery';
import { ArtifactSettingsTab } from './settings-tab';
import { TemplateLibrary } from './template-library';
import { ThemeLibrary } from './theme-library';

type Tab = 'gallery' | 'templates' | 'themes' | 'settings';

/** Everything about artifacts on one page: what was made, what to start from, how it looks. */
@Component({
  selector: 'app-artifacts',
  imports: [ArtifactGallery, ArtifactSettingsTab, Btn, RouterLink, TemplateLibrary, ThemeLibrary],
  template: `
    <section class="gw-page">
      <div class="flex flex-col gap-5">
        <div class="gw-title-rule flex flex-wrap items-end gap-5">
          <div class="flex flex-col gap-2.5">
            <h1 class="gw-h1">Artifacts</h1>
            <p class="m-0 max-w-[62ch] font-serif text-base leading-snug text-muted">
              Documents, presentations and canvases, drawn in gangway's style or a theme of your
              own. Agents start from these templates; so can you.
            </p>
          </div>
          @if (canDeploy()) {
            <a appBtn class="mb-1 ml-auto" routerLink="/artifacts/new" data-testid="new-artifact"
              >New artifact</a
            >
          }
        </div>
        <nav
          class="flex gap-7 overflow-x-auto border-b border-ink text-[13px] font-medium tracking-[.12em] uppercase"
          aria-label="Artifacts"
        >
          @for (t of tabs(); track t.id) {
            <a
              [routerLink]="[]"
              [queryParams]="{ tab: t.id === 'gallery' ? null : t.id }"
              class="py-2.5"
              [class]="
                tab() === t.id
                  ? 'shadow-[inset_0_-3px_0_var(--gw-flag)]'
                  : 'text-muted hover:text-ink'
              "
              [attr.aria-current]="tab() === t.id ? 'page' : null"
              [attr.data-testid]="'tab-' + t.id"
              >{{ t.label }}</a
            >
          }
        </nav>
      </div>
      <!-- A tab once opened stays alive while hidden, so coming back does not reload its frames. -->
      @for (t of opened(); track t) {
        <div [hidden]="tab() !== t" [attr.data-testid]="'panel-' + t">
          @switch (t) {
            @case ('templates') {
              <app-template-library />
            }
            @case ('themes') {
              <app-theme-library />
            }
            @case ('settings') {
              <app-artifact-settings-tab />
            }
            @default {
              <app-artifact-gallery />
            }
          }
        </div>
      }
    </section>
  `,
})
export class ArtifactsPage {
  readonly #auth = inject(AuthService);
  readonly #query = toSignal(inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('tab'))), {
    initialValue: null,
  });
  protected readonly canDeploy = computed(
    () => this.#auth.can('previews.deploy') || this.#auth.can('previews.deploy_static'),
  );
  protected readonly tabs = computed(() => [
    { id: 'gallery' as Tab, label: 'Gallery' },
    { id: 'templates' as Tab, label: 'Templates' },
    { id: 'themes' as Tab, label: 'Themes' },
    ...(this.#auth.can('artifacts.manage') || this.#auth.canWriteOrgSettings()
      ? [{ id: 'settings' as Tab, label: 'Settings' }]
      : []),
  ]);
  protected readonly tab = computed<Tab>(() => {
    const want = this.#query();
    return this.tabs().some((t) => t.id === want) ? (want as Tab) : 'gallery';
  });
  readonly #opened = new Set<Tab>();
  protected readonly opened = computed(() => [...this.#opened.add(this.tab())]);
}
