import { computed, signal } from '@angular/core';
import type { PreviewSourceFiles, RuntimeId, SourceFile } from '../../core/api.types';
import { normalizePath, UploadError } from '../new/pack';

type SourceEntry = {
  path: string;
  size: number;
  editable: boolean;
  status: '' | 'changed' | 'new';
};

const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
const textFile = (path: string, text: string): SourceFile => ({
  path,
  size: new Blob([text]).size,
  text,
});

export class SourceDraft {
  readonly base = signal<PreviewSourceFiles | null>(null);
  readonly edits = signal<ReadonlyMap<string, string>>(new Map());
  readonly deleted = signal<ReadonlySet<string>>(new Set());
  readonly selected = signal<string | null>(null);

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
    return out.sort(byPath);
  });

  readonly changes = computed<Record<string, string | null>>(() => {
    const b = this.base();
    if (!b) return {};
    const out: Record<string, string | null> = {};
    const files = new Map(b.files.map((f) => [f.path, f]));
    for (const [path, text] of this.edits()) if (files.get(path)?.text !== text) out[path] = text;
    for (const path of this.deleted()) if (files.has(path)) out[path] = null;
    return out;
  });

  rebase(src: PreviewSourceFiles): void {
    this.base.set(src);
    this.edits.set(new Map());
    this.deleted.set(new Set());
    const sel = this.selected();
    if (!sel || !src.files.some((f) => f.path === sel && f.text !== undefined)) {
      this.selected.set(src.files.find((f) => f.text !== undefined)?.path ?? null);
    }
  }

  textOf(path: string): string {
    return this.edits().get(path) ?? this.base()?.files.find((f) => f.path === path)?.text ?? '';
  }

  edit(path: string, text: string): void {
    if (this.textOf(path) === text) return;
    const next = new Map(this.edits());
    next.set(path, text);
    this.edits.set(next);
  }

  add(raw: string): string {
    const p = normalizePath(raw.trim());
    if (p === '.gangway' || p.startsWith('.gangway/'))
      throw new UploadError(".gangway/ is gangway's own: it holds the generated build files.");
    if (!this.entries().some((f) => f.path === p)) {
      const del = new Set(this.deleted());
      del.delete(p);
      this.deleted.set(del);
      if (!this.edits().has(p)) this.edits.set(new Map(this.edits()).set(p, ''));
    }
    this.selected.set(p);
    return p;
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

  rename(from: string, to: string): void {
    const text = this.textOf(from);
    const target = this.add(to);
    if (target === from) return;
    this.edit(target, text);
    this.remove(from);
    this.selected.set(target);
  }

  applied(runtime: RuntimeId | null): PreviewSourceFiles {
    const b = this.base()!;
    const changes = this.changes();
    const files = b.files
      .filter((f) => changes[f.path] !== null)
      .map((f) => {
        const text = changes[f.path];
        return typeof text === 'string' ? textFile(f.path, text) : f;
      });
    for (const [path, text] of Object.entries(changes))
      if (text !== null && !b.files.some((f) => f.path === path)) files.push(textFile(path, text));
    return { ...b, files: files.sort(byPath), runtime };
  }
}
