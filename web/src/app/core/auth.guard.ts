import { InjectionToken, inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Only a same-origin PATH is ever followed after login. `//evil.example` and
 * `https://evil.example` are both "URLs that start with something plausible"; a returnUrl
 * is attacker-controlled text in a link someone was sent.
 */
export function safeReturnUrl(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith('/login') || raw.startsWith('/setup')) return '/';
  return raw;
}

/**
 * True for the one return URL that is a SERVER endpoint, not an SPA route: the
 * private-preview gate. It must be reached with a real navigation -- the router would
 * treat it as an unknown path and quietly go home, stranding the visitor on the list.
 */
export const isServerReturn = (url: string): boolean => url.startsWith('/v1/auth/gate?');

/** A full-page navigation. A token so specs can watch it: jsdom cannot navigate. */
export const HARD_NAVIGATE = new InjectionToken<(url: string) => void>('HARD_NAVIGATE', {
  providedIn: 'root',
  factory: () => (url: string) => location.assign(url),
});

/** Everything behind login. First run goes to setup; anyone else to login, and back afterwards. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (auth.authenticated()) return true;
  if (auth.setupRequired()) return router.createUrlTree(['/setup']);
  return router.createUrlTree(['/login'], { queryParams: state.url === '/' ? {} : { returnUrl: state.url } });
};

/** The login page: pointless when already logged in, and wrong when nobody exists yet. */
export const anonymousOnly: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (auth.authenticated()) {
    const to = safeReturnUrl(route.queryParamMap.get('returnUrl'));
    if (isServerReturn(to)) { inject(HARD_NAVIGATE)(to); return false; }
    return router.parseUrl(to);
  }
  if (auth.setupRequired()) return router.createUrlTree(['/setup'], { queryParams: route.queryParams });
  return true;
};

/** The setup page exists exactly while there are no accounts -- the same rule the server applies. */
export const setupOnly: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (auth.setupRequired()) return true;
  return router.createUrlTree([auth.authenticated() ? '/' : '/login']);
};
