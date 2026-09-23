import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  Detected,
  PreviewSourceFiles,
  RedeployAccepted,
  Runtime,
  RuntimeId,
  RuntimeList,
  SourcePatch,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { localProblem, toProblem, type ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ErrorAlert } from '../../ui/error-alert';
import { OWN_LABEL } from '../new/looks';
import { collectFromDrop, packFiles, UploadError, type Collected } from '../new/pack';
import { deployQuery, problemNotes } from '../new/upload';
import { PreviewsStore } from './previews.store';
import { SourceDraft } from './source-draft';
import { SOURCE_FIELD, SourceFiles } from './source-files';

type Status = { text: string; tone: 'info' | 'good' | 'bad' };

const TONE: Record<Status['tone'], string> = {
  bad: 'text-danger',
  good: 'text-ok',
  info: 'text-muted',
};

@Component({
  selector: 'app-source-panel',
  imports: [Btn, ErrorAlert, SourceFiles],
  template: `
    @if (draft.base(); as src) {
      <div class="flex flex-col gap-2.5" data-testid="source">
        <div class="flex flex-wrap items-end gap-4">
          <h2 class="gw-label">Source</h2>
          <span class="font-mono text-xs text-muted" data-testid="runtime">{{
            runtimeName(src.runtime)
          }}</span>
          @if (canUpdate()) {
            <label class="gw-label ml-auto flex items-baseline gap-3"
              >Rebuild as
              <select
                [class]="field + ' font-normal tracking-normal normal-case'"
                (change)="runtimeChoice.set($any($event.target).value)"
                data-testid="rebuild-runtime"
              >
                <option value="">{{ runtimeName(src.runtime) }} (current)</option>
                @for (r of runtimes(); track r.id) {
                  @if (r.id !== src.runtime) {
                    <option [value]="r.id">{{ r.name }}</option>
                  }
                }
                @if (src.runtime !== null) {
                  <option value="own">{{ ownLabel }}</option>
                }
              </select>
            </label>
            <button
              appBtn
              type="button"
              (click)="save()"
              [disabled]="!dirty() || busy()"
              data-testid="save"
            >
              Save &amp; rebuild
            </button>
          }
        </div>

        @if (status(); as s) {
          <p class="text-sm" [class]="tone[s.tone]" role="status" data-testid="redeploy-status">
            {{ s.text }}
          </p>
        }
        @if (error(); as e) {
          <app-error-alert class="px-4 py-3" [problem]="e" data-testid="source-error">
            @for (n of notes(); track $index) {
              <p class="mt-1 font-mono text-xs whitespace-pre-wrap">{{ n }}</p>
            }
          </app-error-alert>
        }

        <app-source-files
          [draft]="draft"
          [canUpdate]="canUpdate()"
          [truncated]="src.truncated"
          (save)="save()"
          (refused)="refuse($event)"
        />

        @if (canUpdate()) {
          <div
            (dragover)="$event.preventDefault(); dragging.set(true)"
            (dragleave)="dragging.set(false)"
            (drop)="dropped($event)"
            class="mt-2 border border-dashed px-4 py-5 text-center text-sm text-muted transition"
            [class]="dragging() ? 'border-ink bg-flag/20' : 'border-rule'"
            data-testid="replace"
          >
            <span class="font-medium">Replace files:</span> drop files, a folder or a .zip to swap
            the whole source and rebuild.
          </div>
        }
        <p class="text-xs text-muted">
          The previous version keeps serving until the new one is built. Build output streams into
          the log.
        </p>
      </div>
    }
  `,
})
export class SourcePanel {
  readonly previewId = input.required<string>();
  readonly uploaded = input.required<boolean>();

  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #store = inject(PreviewsStore);

  protected readonly field = SOURCE_FIELD;
  protected readonly ownLabel = OWN_LABEL;
  protected readonly tone = TONE;

  readonly draft = new SourceDraft();
  protected readonly canUpdate = computed(() => this.#auth.can('previews.update'));
  protected readonly runtimes = signal<Runtime[]>([]);
  protected readonly runtimeChoice = signal<Detected | ''>('');
  protected readonly dragging = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<ProblemError | null>(null);
  protected readonly notes = signal<string[]>([]);
  readonly #pending = signal<string | null>(null);

  protected readonly dirty = computed(
    () => Object.keys(this.draft.changes()).length > 0 || this.runtimeChoice() !== '',
  );

  protected readonly status = computed<Status | null>(() => {
    const e = this.#store.redeployOf(this.previewId())();
    const pending = this.#pending();
    if (!e || (pending !== null && e.buildId !== pending))
      return pending ? { text: 'Saved. Rebuilding…', tone: 'info' } : null;
    switch (e.phase) {
      case 'started':
        return {
          text: 'Rebuilding… the previous version keeps serving until the new one is built.',
          tone: 'info',
        };
      case 'succeeded':
        return { text: 'Rebuilt: the new version is live.', tone: 'good' };
      default:
        return {
          text: `Rebuild failed${e.error ? `: ${e.error}` : ''}. See the log below.`,
          tone: 'bad',
        };
    }
  });

  constructor() {
    effect(() => {
      const id = this.previewId();
      if (!this.uploaded() || !this.#auth.can('previews.read')) return;
      untracked(() => void this.#load(id));
    });
  }

  async #load(id: string): Promise<void> {
    try {
      const src = await firstValueFrom(
        this.#http.get<PreviewSourceFiles>(`/v1/previews/${id}/source`),
      );
      if (this.previewId() !== id) return;
      this.draft.rebase(src);
    } catch (e) {
      if (!(e instanceof HttpErrorResponse && e.status === 404)) {
        this.error.set(toProblem(e));
      }
      return;
    }
    if (this.canUpdate() && this.runtimes().length === 0) {
      void firstValueFrom(this.#http.get<RuntimeList>('/v1/runtimes')).then(
        (r) => this.runtimes.set(r.runtimes),
        () => {},
      );
    }
  }

  protected runtimeName(id: RuntimeId | null): string {
    if (id === null) return OWN_LABEL;
    return this.runtimes().find((r) => r.id === id)?.name ?? id;
  }

  async save(): Promise<void> {
    if (!this.canUpdate() || !this.dirty() || this.busy()) return;
    const body: SourcePatch = {
      files: this.draft.changes(),
      ...(this.runtimeChoice() ? { runtime: this.runtimeChoice() as Detected } : {}),
    };
    await this.#submit(() =>
      firstValueFrom(
        this.#http.patch<RedeployAccepted>(`/v1/previews/${this.previewId()}/source`, body),
      ),
    );
  }

  protected async dropped(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.dragging.set(false);
    if (!e.dataTransfer) return;
    let c: Collected;
    try {
      c = await collectFromDrop(e.dataTransfer);
    } catch (err) {
      this.refuse(err);
      return;
    }
    await this.replace(c);
  }

  async replace(c: Collected): Promise<void> {
    if (c.files.length === 0) {
      this.refuse(new UploadError('Nothing to upload: no files were found.'));
      return;
    }
    const runtime = this.runtimeChoice() || this.draft.base()?.runtime || 'own';
    const url = `/v1/previews/${this.previewId()}/source${deployQuery({ runtime })}`;
    await this.#submit(
      () =>
        firstValueFrom(
          this.#http.put<RedeployAccepted>(url, packFiles(c.files), {
            headers: { 'content-type': 'application/gzip' },
          }),
        ),
      true,
    );
  }

  async #submit(call: () => Promise<RedeployAccepted>, refetch = false): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.notes.set([]);
    try {
      const res = await call();
      this.#pending.set(res.buildId);
      const b = this.draft.base();
      if (refetch || !b) await this.#load(this.previewId());
      else this.draft.rebase(this.draft.applied(this.#nextRuntime(b.runtime)));
      this.runtimeChoice.set('');
    } catch (e) {
      this.error.set(toProblem(e));
      this.notes.set(problemNotes(e));
      if (toProblem(e).status === 403) void this.#auth.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  #nextRuntime(current: RuntimeId | null): RuntimeId | null {
    const c = this.runtimeChoice();
    return c === '' ? current : c === 'own' ? null : c;
  }

  protected refuse(e: unknown): void {
    this.error.set(e === null ? null : localProblem('Cannot do that', e));
    this.notes.set([]);
  }
}
