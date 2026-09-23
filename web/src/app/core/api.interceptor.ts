import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { tap } from 'rxjs';
import { AuthService } from './auth.service';

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
