import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ArtifactKind } from '../../core/artifact.types';
import { KIND_LABELS, type ArtifactItem } from '../../core/artifacts.types';
import type { ProblemError } from '../../core/problem';
import { EmptyState } from '../../ui/empty-state';
import { FIELD } from '../../ui/field';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { Skeleton } from '../../ui/skeleton';
import { StateBadge } from '../../ui/state-badge';
import { ArtifactsService } from './artifacts.service';
import { GalleryThumb } from './gallery-thumb';

type Filter = ArtifactKind | 'all';
export type GallerySort = 'newest' | 'oldest' | 'updated' | 'name';

export const GALLERY_SORTS: { id: GallerySort; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'name', label: 'Name, A to Z' },
];

const nameOf = (a: ArtifactItem) => a.preview.title ?? a.preview.project;

export function sortArtifacts(items: readonly ArtifactItem[], by: GallerySort): ArtifactItem[] {
  const out = [...items];
  if (by === 'name') return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const key = by === 'updated' ? 'updatedAt' : 'createdAt';
  const sign = by === 'oldest' ? 1 : -1;
  return out.sort((a, b) => sign * (Date.parse(a.preview[key]) - Date.parse(b.preview[key])));
}

/** The artifacts deployed here, each with a live thumbnail when it is open to view. */
@Component({
  selector: 'app-artifact-gallery',
  imports: [EmptyState, GalleryThumb, RelativeTimePipe, RouterLink, Skeleton, StateBadge],
  template: `
    <div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap gap-2" role="group" aria-label="Kind">
          @for (f of filters; track f.id) {
            <button
              type="button"
              class="px-3 py-1.5 text-[11px] font-semibold tracking-[.14em] uppercase"
              [class]="
                filter() === f.id
                  ? 'bg-ink text-paper'
                  : 'text-muted shadow-[inset_0_0_0_1px_var(--gw-rule)] hover:text-ink'
              "
              (click)="filter.set(f.id)"
              [attr.data-testid]="'filter-' + f.id"
            >
              {{ f.label }}
            </button>
          }
        </div>
        <label class="flex items-center gap-2">
          <span class="gw-label">Sort</span>
          <select
            [class]="field + ' w-auto'"
            (change)="sort.set($any($event.target).value)"
            data-testid="gallery-sort"
          >
            @for (o of sorts; track o.id) {
              <option [value]="o.id" [selected]="sort() === o.id">{{ o.label }}</option>
            }
          </select>
        </label>
      </div>
      @if (error(); as e) {
        <p class="text-sm text-danger" role="alert">{{ e.detail }}</p>
      }
      @if (!loaded() && !error()) {
        <app-skeleton kind="cards" [count]="6" label="Loading artifacts" />
      } @else if (loaded() && shown().length === 0) {
        <app-empty-state heading="No artifacts yet">
          Start one from a template with New artifact, or ask your agent: whatever it deploys
          appears here.
        </app-empty-state>
      }
      <div class="gw-enter grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="gallery">
        @for (a of shown(); track a.preview.id) {
          <a
            [routerLink]="['/previews', a.preview.id]"
            class="group flex flex-col gap-3"
            [attr.data-testid]="'artifact-' + a.preview.project"
          >
            <div class="gw-neatline relative aspect-[16/10] overflow-hidden bg-surface">
              @if (viewable(a)) {
                <app-gallery-thumb
                  [url]="a.preview.urls[0]!.url"
                  [label]="a.preview.title ?? a.preview.project"
                />
              } @else {
                <span
                  class="absolute inset-0 grid place-items-center font-mono text-xs text-muted"
                  >{{ a.preview.visibility === 'private' ? 'private' : 'behind a password' }}</span
                >
              }
            </div>
            <div class="flex flex-col gap-1">
              <span class="gw-label flex items-center gap-2">
                {{ a.kind ? kindLabels[a.kind] : 'Artifact' }}
                @if (a.theme) {
                  <span class="normal-case">· {{ a.theme }}</span>
                }
              </span>
              <span class="font-serif text-xl leading-tight italic group-hover:underline">{{
                a.preview.title ?? a.preview.project
              }}</span>
              <span class="flex items-center gap-3 text-xs text-muted">
                <app-state-badge [state]="a.preview.state" />
                <span>{{ a.preview.createdAt | relativeTime: now }}</span>
              </span>
            </div>
          </a>
        }
      </div>
    </div>
  `,
})
export class ArtifactGallery {
  readonly #svc = inject(ArtifactsService);
  protected readonly kindLabels = KIND_LABELS;
  protected readonly field = FIELD;
  protected readonly sorts = GALLERY_SORTS;
  protected readonly sort = signal<GallerySort>('newest');
  protected readonly now = Date.now();
  readonly #list = this.#svc.listQuery();
  protected readonly items = computed<ArtifactItem[]>(() => this.#list.data() ?? []);
  protected readonly loaded = this.#list.loaded;
  // A failed refresh behind a list already shown keeps the list; only a first load shows the error.
  protected readonly error = computed<ProblemError | null>(() =>
    this.loaded() ? null : this.#list.error(),
  );
  protected readonly filter = signal<Filter>('all');
  protected readonly filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'document', label: 'Documents' },
    { id: 'deck', label: 'Presentations' },
    { id: 'canvas', label: 'Canvases' },
  ];
  protected readonly shown = computed(() => {
    const f = this.filter();
    return sortArtifacts(
      this.items().filter((a) => f === 'all' || a.kind === f),
      this.sort(),
    );
  });

  /** Only a page a stranger could open draws in a frame; the rest would show a gate. */
  protected viewable(a: ArtifactItem): boolean {
    const p = a.preview;
    return p.state === 'awake' && p.access === 'open' && p.visibility !== 'private' && !!p.urls[0];
  }
}
