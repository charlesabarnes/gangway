import { HttpErrorResponse } from '@angular/common/http';

/**
 * What a refused upload says beyond its `detail`: the compose policy's violations, and
 * compose's own stderr. The server spreads them into the problem body (ADR-0015 changes
 * nothing about that); `toProblem` keeps only the common fields, so they are read here.
 */
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

/** Query-string options for a tarball deploy (`TarballDeployQuerySchema`), empties dropped. */
export function deployQuery(o: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o))
    if (v !== null && v !== undefined && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** `12.3 KiB` -- sizes on screen. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KiB`;
  return `${Math.round(n / 1024 / 102.4) / 10} MiB`;
}
