import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Project } from '../../core/api.types';
import { Clock } from '../../core/clock';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { StateBadge } from '../../ui/state-badge';
import { PreviewsStore } from '../previews/previews.store';

@Component({
  selector: 'app-project-previews',
  host: { class: 'block' },
  imports: [RelativeTimePipe, RouterLink, StateBadge],
  template: `
    @let p = project();
    <div class="mt-6" data-testid="previews">
      @for (pv of previews(); track pv.id) {
        <a
          [routerLink]="['/previews', pv.id]"
          class="flex items-center gap-4 border-b border-neutral-200 py-3 text-sm last:border-0 hover:text-accent dark:border-neutral-800"
          data-testid="preview"
        >
          <app-state-badge [state]="pv.state" />
          <span class="font-mono">{{ pv.project.replace(prefix(pv.project), '') }}</span>
          <span class="text-neutral-500">{{
            pv.source.kind === 'pr' ? '#' + $any(pv.source).number : pv.source.kind
          }}</span>
          <span class="ml-auto text-xs text-neutral-500">{{
            pv.createdAt | relativeTime: clock.now()
          }}</span>
        </a>
      } @empty {
        <p class="py-10 text-center text-sm text-neutral-500" data-testid="no-previews">
          @if (p.fullName && p.prTrigger === 'workflow') {
            No previews yet. Add
            <a
              [routerLink]="[]"
              [queryParams]="{ tab: 'workflow' }"
              class="text-accent hover:underline"
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
