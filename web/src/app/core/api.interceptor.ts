import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { tap } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * A 401 from the API means the session ended under an open tab -- expired, revoked by a
 * password reset, or the account was disabled. Forget it and go to login, remembering where
 * the person was.
 *
 * Not for `/v1/auth/*`: a 401 from login IS the answer ("wrong password"), not a lost session.
 *
 * There is deliberately no CSRF header to add. The server checks `Origin`, which the
 * browser sends on its own and a hostile page cannot forge (ADR-0010).
 */
export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req).pipe(
    tap({
      error: (e: unknown) => {
        if (!(e instanceof HttpErrorResponse) || e.status !== 401) return;
        if (!req.url.startsWith('/v1/') || req.url.startsWith('/v1/auth/')) return;
        auth.clear();
        const at = router.url;
        if (at.startsWith('/login')) return;
        void router.navigate(['/login'], {
          queryParams: at === '/' || at === '' ? {} : { returnUrl: at },
        });
      },
    }),
  );
};
