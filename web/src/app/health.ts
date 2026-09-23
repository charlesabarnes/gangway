import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

export type Health =
  { status: 'ok'; routes: number } | { status: 'draining' } | { status: 'unreachable' };

@Injectable({ providedIn: 'root' })
export class HealthService {
  readonly #http = inject(HttpClient);

  check(): Observable<Health> {
    return this.#http.get<{ ok: boolean; routes?: number }>('/healthz').pipe(
      map((h): Health => ({ status: 'ok', routes: h.routes ?? 0 })),
      catchError((e: { status?: number }) =>
        of<Health>({ status: e.status === 503 ? 'draining' : 'unreachable' }),
      ),
    );
  }
}
