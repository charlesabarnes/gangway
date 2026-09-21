import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

export type Health =
  | { status: 'ok'; routes: number }
  | { status: 'draining' }
  | { status: 'unreachable' };

/** `/healthz` is the one unauthenticated endpoint, so the shell can show it before login exists. */
@Injectable({ providedIn: 'root' })
export class HealthService {
  readonly #http = inject(HttpClient);

  check(): Observable<Health> {
    return this.#http.get<{ ok: boolean; routes?: number }>('/healthz').pipe(
      map((h): Health => ({ status: 'ok', routes: h.routes ?? 0 })),
      // 503 + { draining: true } is a server that is shutting down, not one that is gone.
      catchError((e: { status?: number }) => of<Health>({ status: e.status === 503 ? 'draining' : 'unreachable' })),
    );
  }
}
