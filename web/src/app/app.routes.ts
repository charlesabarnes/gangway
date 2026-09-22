import { Routes } from '@angular/router';
import { anonymousOnly, authGuard, setupOnly } from './core/auth.guard';

/**
 * Every screen is a lazy chunk: the login page should not download the log viewer. The spec
 * caps the product at eight screens (§10.3) -- "a dashboard is how this becomes Coolify".
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'previews' },
  { path: 'login', title: 'Log in · gangway', canActivate: [anonymousOnly], loadComponent: () => import('./features/auth/login').then((m) => m.Login) },
  { path: 'setup', title: 'Set up · gangway', canActivate: [setupOnly], loadComponent: () => import('./features/auth/setup').then((m) => m.Setup) },
  { path: 'previews', title: 'Previews · gangway', canActivate: [authGuard], loadComponent: () => import('./features/previews/preview-list').then((m) => m.PreviewList) },
  { path: 'previews/:id', title: 'Preview · gangway', canActivate: [authGuard], loadComponent: () => import('./features/previews/preview-detail').then((m) => m.PreviewDetail) },
  { path: 'account', title: 'Account · gangway', canActivate: [authGuard], loadComponent: () => import('./features/account/account').then((m) => m.Account) },
  { path: 'github', title: 'GitHub · gangway', canActivate: [authGuard], loadComponent: () => import('./features/github/github').then((m) => m.GitHub) },
  // GitHub's manifest flow sends the browser back here with ?code=&state= (ADR-0011).
  { path: 'github/callback', title: 'GitHub · gangway', canActivate: [authGuard], loadComponent: () => import('./features/github/github-callback').then((m) => m.GitHubCallback) },
  // The server answers every unknown path on the `app` surface with index.html (SPA
  // fallback), so an unknown path is the router's to handle, not a 404 page's.
  { path: '**', redirectTo: '' },
];
