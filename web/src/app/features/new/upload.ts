import { HttpErrorResponse } from '@angular/common/http';

export function problemNotes(e: unknown): string[] {
  if (!(e instanceof HttpErrorResponse) || e.error === null || typeof e.error !== 'object')
    return [];
  const body = e.error as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(body['violations'])) out.push(...(body['violations'] as unknown[]).map(String));
  if (typeof body['compose'] === 'string' && body['compose'].trim() !== '')
    out.push(body['compose'].trim());
  return out;
}

export function deployQuery(o: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o))
    if (v !== null && v !== undefined && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KiB`;
  return `${Math.round(n / 1024 / 102.4) / 10} MiB`;
}
