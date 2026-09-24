import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Project } from '../../core/api.types';
import { Clock } from '../../core/clock';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { PreviewIconTile } from '../../ui/preview-icon';
import { StateBadge } from '../../ui/state-badge';
import { PreviewsStore } from '../previews/previews.store';

@Component({
  selector: 'app-project-previews',
  host: { class: 'block' },
  imports: [PreviewIconTile, RelativeTimePipe, RouterLink, StateBadge],
  template: `
    @let p = project();
    <div data-testid="previews">
      @for (pv of previews(); track pv.id) {
        <a
          [routerLink]="['/previews', pv.id]"
          class="flex items-center gap-4 border-b border-rule py-3 text-sm hover:bg-ink/5"
          data-testid="preview"
        >
          <app-state-badge class="w-[90px] shrink-0" [state]="pv.state" />
          <app-preview-icon [icon]="pv.icon" [source]="pv.source.kind" [size]="24" />
          <span class="text-[13px]" [class.font-mono]="!pv.title">{{
            pv.title ?? pv.project.replace(prefix(pv.project), '')
          }}</span>
          <span class="text-muted">{{
            pv.source.kind === 'pr' ? '#' + $any(pv.source).number : pv.source.kind
          }}</span>
          <span class="ml-auto text-muted">{{ pv.createdAt | relativeTime: clock.now() }}</span>
        </a>
      } @empty {
        <p class="py-10 text-center text-sm text-muted" data-testid="no-previews">
          @if (p.fullName && p.prTrigger === 'workflow') {
            No previews yet. Add
            <a
              [routerLink]="[]"
              [queryParams]="{ tab: 'workflow' }"
              class="text-ink underline underline-offset-2"
              >the workflow</a
            >
            and open a pull request.
          } @else if (p.fullName) {
            No previews yet. Open a pull request on {{ p.fullName }}.
          } @else {
            No previews yet. Deploy an image or tarball with
            <code class="font-mono">"project": "{{ p.slug }}"</code>.
          }
        </p>
      }
    </div>
  `,
})
export class ProjectPreviews {
  readonly project = input.required<Project>();

  protected readonly clock = inject(Clock);
  readonly #store = inject(PreviewsStore);

  protected readonly previews = computed(() => {
    const id = this.project().id;
    return this.#store.previews().filter((p) => p.projectId === id);
  });

  protected prefix(project: string): string {
    return /^gw-[^-]+-/.exec(project)?.[0] ?? '';
  }
}
