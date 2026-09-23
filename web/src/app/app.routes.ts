import { Routes } from '@angular/router';
import { anonymousOnly, authGuard, setupOnly } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'previews' },
  {
    path: 'login',
    title: 'Log in · gangway',
    canActivate: [anonymousOnly],
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  {
    path: 'setup',
    title: 'Set up · gangway',
    canActivate: [setupOnly],
    loadComponent: () => import('./features/auth/setup').then((m) => m.Setup),
  },
  {
    path: 'previews',
    title: 'Previews · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/previews/preview-list').then((m) => m.PreviewList),
  },
  {
    path: 'new',
    title: 'New preview · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/new/new-preview').then((m) => m.NewPreview),
  },
  {
    path: 'previews/:id',
    title: 'Preview · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/previews/preview-detail').then((m) => m.PreviewDetail),
  },
  {
    path: 'account',
    title: 'Account · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/account/account').then((m) => m.Account),
  },
  {
    path: 'projects',
    title: 'Projects · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/projects/projects').then((m) => m.ProjectsPage),
  },
  {
    path: 'projects/:ref',
    title: 'Project · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/projects/project').then((m) => m.ProjectPage),
  },
  { path: 'repos', redirectTo: 'projects' },
  {
    path: 'templates',
    title: 'Templates · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/templates/templates').then((m) => m.TemplatesPage),
  },
  {
    path: 'settings',
    title: 'Settings · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/settings/settings').then((m) => m.SettingsPage),
  },
  {
    path: 'github/callback',
    title: 'GitHub · gangway',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/settings/github-callback').then((m) => m.GitHubCallback),
  },
  { path: 'github', redirectTo: 'settings' },
  {
    path: 'connect',
    title: 'Connect an app · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/connect/connect').then((m) => m.Connect),
  },
  { path: '**', redirectTo: '' },
];
