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
import { toProblem, type ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import {
  collectFromDrop,
  normalizePath,
  packFiles,
  UploadError,
  type Collected,
} from '../new/pack';
import { formatBytes, problemNotes, deployQuery } from '../new/upload';
import { CodeEditor } from './code-editor';
import { PreviewsStore } from './previews.store';

const FIELD =
  'rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';

export type SourceEntry = {
  path: string;
  size: number;
  editable: boolean;
  status: '' | 'changed' | 'new';
};

@Component({
  selector: 'app-source-panel',
  imports: [Btn, CodeEditor],
  template: `
    @if (base(); as src) {
      <div class="mt-10" data-testid="source">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="text-sm font-medium text-neutral-500">Source</h2>
          <span class="text-xs text-neutral-500" data-testid="runtime">{{
            runtimeName(src.runtime)
          }}</span>
          @if (canUpdate()) {
            <label class="ml-auto text-xs text-neutral-500"
              >Rebuild as
              <select
                [class]="field"
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
                  <option value="own">Own Dockerfile / compose</option>
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
          <p
            class="mt-2 text-sm"
            [class]="
              s.tone === 'bad'
                ? 'text-red-700 dark:text-red-400'
                : s.tone === 'good'
                  ? 'text-green-700 dark:text-green-400'
                  : 'text-neutral-600 dark:text-neutral-400'
            "
            role="status"
            data-testid="redeploy-status"
          >
            {{ s.text }}
          </p>
        }
        @if (error(); as e) {
          <div
            class="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
            role="alert"
            data-testid="source-error"
          >
            <p>
              {{ e.detail }}
              @if (e.requestId) {
                <span class="font-mono text-xs opacity-70"> (request {{ e.requestId }})</span>
              }
            </p>
            @for (n of notes(); track $index) {
              <p class="mt-1 font-mono text-xs whitespace-pre-wrap">{{ n }}</p>
            }
          </div>
        }

        <div class="mt-3 grid gap-4 md:grid-cols-4">
          <div class="md:col-span-1">
            <ul
              class="max-h-[28rem] overflow-y-auto rounded-lg border border-neutral-200 text-sm dark:border-neutral-800"
              data-testid="files"
            >
              @for (f of entries(); track f.path) {
                <li>
                  <button
                    type="button"
                    (click)="select(f.path)"
                    [disabled]="!f.editable"
                    [title]="f.editable ? f.path : f.path + ' — binary or too large to edit'"
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default"
                    [class]="
                      selected() === f.path
                        ? 'bg-accent/10 text-accent'
                        : f.editable
                          ? 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                          : 'text-neutral-400'
                    "
                    data-testid="file"
                    [attr.data-path]="f.path"
                  >
                    <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ f.path }}</span>
                    @if (f.status) {
                      <span class="text-[10px] text-amber-600 dark:text-amber-400">{{
                        f.status
                      }}</span>
                    }
                    @if (!f.editable) {
                      <span class="text-[10px]">{{ size(f.size) }}</span>
                    }
                  </button>
                </li>
              }
            </ul>
            @if (src.truncated) {
              <p class="mt-1 text-xs text-neutral-500">Only the first files are listed.</p>
            }
            @if (canUpdate()) {
              <form (submit)="$event.preventDefault(); addFile()" class="mt-3 flex gap-2">
                <input
                  [class]="field + ' min-w-0 flex-1 font-mono text-xs'"
                  placeholder="new/file.ts"
                  [value]="newPath()"
                  (input)="newPath.set($any($event.target).value)"
                  aria-label="New file path"
                  data-testid="new-path"
                />
                <button
                  appBtn
                  variant="ghost"
                  type="submit"
                  [disabled]="!newPath().trim()"
                  data-testid="add"
                >
                  Add
                </button>
              </form>
            }
          </div>

          <div class="md:col-span-3">
            @if (selected(); as path) {
              <div class="mb-2 flex items-center gap-2">
                <span
                  class="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500"
                  data-testid="selected"
                  >{{ path }}</span
                >
                @if (canUpdate()) {
                  <button
                    type="button"
                    (click)="rename()"
                    class="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                    data-testid="rename"
                  >
                    Move to new path
                  </button>
                  <button
                    type="button"
                    (click)="remove(path)"
                    class="text-xs text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
                    data-testid="delete"
                  >
                    Delete
                  </button>
                }
              </div>
              @defer (on idle) {
                <app-code-editor
                  [path]="path"
                  [value]="textOf(path)"
                  [readonly]="!canUpdate()"
                  (changed)="edit(path, $event)"
                  (save)="save()"
                />
              } @placeholder {
                <div
                  class="h-80 rounded-md border border-neutral-300 dark:border-neutral-700"
                  data-testid="editor-loading"
                ></div>
              }
            } @else {
              <p
                class="rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700"
              >
                Pick a file to edit.
              </p>
            }
          </div>
        </div>

        @if (canUpdate()) {
          <div
            (dragover)="$event.preventDefault(); dragging.set(true)"
            (dragleave)="dragging.set(false)"
            (drop)="dropped($event)"
            class="mt-4 rounded-lg border-2 border-dashed px-4 py-5 text-center text-sm text-neutral-500 transition"
            [class]="
              dragging()
                ? 'border-accent bg-accent/5'
                : 'border-neutral-300 dark:border-neutral-700'
            "
            data-testid="replace"
          >
            <span class="font-medium">Replace files:</span> drop files, a folder or a .zip to swap
            the whole source and rebuild.
          </div>
        }
        <p class="mt-2 text-xs text-neutral-500">
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

  protected readonly field = FIELD;
  protected readonly size = formatBytes;

  protected readonly canUpdate = computed(() => this.#auth.can('previews.update'));
  readonly base = signal<PreviewSourceFiles | null>(null);
  protected readonly runtimes = signal<Runtime[]>([]);
  readonly edits = signal<ReadonlyMap<string, string>>(new Map());
  readonly deleted = signal<ReadonlySet<string>>(new Set());
  readonly selected = signal<string | null>(null);
  protected readonly newPath = signal('');
  protected readonly runtimeChoice = signal<Detected | ''>('');
  protected readonly dragging = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<ProblemError | null>(null);
  protected readonly notes = signal<string[]>([]);
  readonly #pending = signal<string | null>(null);

  readonly entries = computed<SourceEntry[]>(() => {
    const b = this.base();
    if (!b) return [];
    const edits = this.edits(),
      deleted = this.deleted();
    const known = new Set(b.files.map((f) => f.path));
    const out: SourceEntry[] = b.files
      .filter((f) => !deleted.has(f.path))
      .map((f) => ({
        path: f.path,
        size: f.size,
        editable: f.text !== undefined,
        status: edits.has(f.path) && edits.get(f.path) !== f.text ? 'changed' : '',
      }));
    for (const [path, text] of edits)
      if (!known.has(path)) out.push({ path, size: text.length, editable: true, status: 'new' });
    return out.sort((a, b2) => a.path.localeCompare(b2.path));
  });

  readonly changes = computed<Record<string, string | null>>(() => {
    const b = this.base();
    if (!b) return {};
    const out: Record<string, string | null> = {};
    const byPath = new Map(b.files.map((f) => [f.path, f]));
    for (const [path, text] of this.edits()) if (byPath.get(path)?.text !== text) out[path] = text;
    for (const path of this.deleted()) if (byPath.has(path)) out[path] = null;
    return out;
  });

  protected readonly dirty = computed(
    () => Object.keys(this.changes()).length > 0 || this.runtimeChoice() !== '',
  );

  protected readonly status = computed<{ text: string; tone: 'info' | 'good' | 'bad' } | null>(
    () => {
      const e = this.#store.redeployOf(this.previewId())();
      const pending = this.#pending();
      if (e && (pending === null || e.buildId === pending)) {
        if (e.phase === 'started')
          return {
            text: 'Rebuilding… the previous version keeps serving until the new one is built.',
            tone: 'info',
          };
        if (e.phase === 'succeeded')
          return { text: 'Rebuilt: the new version is live.', tone: 'good' };
        return {
          text: `Rebuild failed${e.error ? `: ${e.error}` : ''}. See the log below.`,
          tone: 'bad',
        };
      }
      return pending ? { text: 'Saved. Rebuilding…', tone: 'info' } : null;
    },
  );

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
      this.#rebase(src);
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

  #rebase(src: PreviewSourceFiles): void {
    this.base.set(src);
    this.edits.set(new Map());
    this.deleted.set(new Set());
    const sel = this.selected();
    if (!sel || !src.files.some((f) => f.path === sel && f.text !== undefined)) {
      this.selected.set(src.files.find((f) => f.text !== undefined)?.path ?? null);
    }
  }

  protected runtimeName(id: RuntimeId | null): string {
    if (id === null) return 'Own Dockerfile / compose';
    return this.runtimes().find((r) => r.id === id)?.name ?? id;
  }

  textOf(path: string): string {
    return this.edits().get(path) ?? this.base()?.files.find((f) => f.path === path)?.text ?? '';
  }

  select(path: string): void {
    this.selected.set(path);
  }

  edit(path: string, text: string): void {
    if (this.textOf(path) === text) return;
    const next = new Map(this.edits());
    next.set(path, text);
    this.edits.set(next);
  }

  addFile(path = this.newPath()): void {
    this.error.set(null);
    let p: string;
    try {
      p = normalizePath(path.trim());
    } catch (e) {
      this.#localError(e);
      return;
    }
    if (p === '.gangway' || p.startsWith('.gangway/')) {
      this.#localError(
        new UploadError(".gangway/ is gangway's own: it holds the generated build files."),
      );
      return;
    }
    if (this.entries().some((f) => f.path === p)) {
      this.selected.set(p);
      this.newPath.set('');
      return;
    }
    const del = new Set(this.deleted());
    del.delete(p);
    this.deleted.set(del);
    if (!this.edits().has(p)) {
      const next = new Map(this.edits());
      next.set(p, '');
      this.edits.set(next);
    }
    this.selected.set(p);
    this.newPath.set('');
  }

  remove(path: string): void {
    const edits = new Map(this.edits());
    edits.delete(path);
    this.edits.set(edits);
    if (this.base()?.files.some((f) => f.path === path)) {
      const del = new Set(this.deleted());
      del.add(path);
      this.deleted.set(del);
    }
    if (this.selected() === path)
      this.selected.set(this.entries().find((f) => f.editable)?.path ?? null);
  }

  protected rename(): void {
    const from = this.selected();
    const to = this.newPath().trim();
    if (!from) return;
    if (!to) {
      this.#localError(
        new UploadError('Type the new path in the box under the file list, then Move.'),
      );
      return;
    }
    const text = this.textOf(from);
    this.addFile(to);
    const target = this.selected();
    if (!target || target === from) return;
    this.edit(target, text);
    this.remove(from);
    this.selected.set(target);
  }

  async save(): Promise<void> {
    if (!this.canUpdate() || !this.dirty() || this.busy()) return;
    const body: SourcePatch = {
      files: this.changes(),
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
      this.#localError(err);
      return;
    }
    await this.replace(c);
  }

  async replace(c: Collected): Promise<void> {
    if (c.files.length === 0) {
      this.#localError(new UploadError('Nothing to upload: no files were found.'));
      return;
    }
    const runtime = this.runtimeChoice() || this.base()?.runtime || 'own';
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
      const b = this.base();
      if (refetch || !b) {
        await this.#load(this.previewId());
      } else {
        const changes = this.changes();
        const files = b.files
          .filter((f) => !(f.path in changes) || changes[f.path] !== null)
          .map((f) =>
            typeof changes[f.path] === 'string'
              ? { path: f.path, size: new Blob([changes[f.path]!]).size, text: changes[f.path]! }
              : f,
          );
        for (const [path, text] of Object.entries(changes))
          if (text !== null && !b.files.some((f) => f.path === path))
            files.push({ path, size: new Blob([text]).size, text });
        this.#rebase({
          ...b,
          files: files.sort((x, y) => x.path.localeCompare(y.path)),
          runtime: this.#nextRuntime(b.runtime),
        });
      }
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

  #localError(e: unknown): void {
    this.error.set({
      status: 0,
      title: 'Cannot do that',
      detail: e instanceof Error ? e.message : String(e),
      requestId: null,
      retryAfter: null,
      issues: [],
    });
    this.notes.set([]);
  }
}
