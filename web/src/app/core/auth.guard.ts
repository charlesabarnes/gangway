import { InjectionToken, inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

// returnUrl is attacker-controlled, so only a same-origin path is followed.
export function safeReturnUrl(raw: string | null | undefined): string {
  if (
    !raw ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.startsWith('/\\') ||
    raw.startsWith('/login') ||
    raw.startsWith('/setup')
  )
    return '/';
  return raw;
}

export const isServerReturn = (url: string): boolean => url.startsWith('/v1/auth/gate?');

export const HARD_NAVIGATE = new InjectionToken<(url: string) => void>('HARD_NAVIGATE', {
  providedIn: 'root',
  factory: () => (url: string) => location.assign(url),
});

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (auth.authenticated()) return true;
  if (auth.setupRequired()) return router.createUrlTree(['/setup']);
  return router.createUrlTree(['/login'], {
    queryParams: state.url === '/' ? {} : { returnUrl: state.url },
  });
};

export const anonymousOnly: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (auth.authenticated()) {
    const to = safeReturnUrl(route.queryParamMap.get('returnUrl'));
    if (isServerReturn(to)) {
      inject(HARD_NAVIGATE)(to);
      return false;
    }
    return router.parseUrl(to);
  }
  if (auth.setupRequired())
    return router.createUrlTree(['/setup'], { queryParams: route.queryParams });
  return true;
};

export const setupOnly: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (auth.setupRequired()) return true;
  return router.createUrlTree([auth.authenticated() ? '/' : '/login']);
};
