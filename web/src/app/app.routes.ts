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
    path: 'repositories',
    title: 'Repositories · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/projects/projects').then((m) => m.ProjectsPage),
  },
  {
    path: 'repositories/:ref',
    title: 'Repository · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/projects/project').then((m) => m.ProjectPage),
  },
  { path: 'projects', redirectTo: 'repositories' },
  { path: 'projects/:ref', redirectTo: 'repositories/:ref' },
  { path: 'repos', redirectTo: 'repositories' },
  {
    path: 'artifacts',
    title: 'Artifacts · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/artifacts/artifacts-page').then((m) => m.ArtifactsPage),
  },
  {
    path: 'artifacts/new',
    title: 'New artifact · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/artifacts/new-artifact').then((m) => m.NewArtifact),
  },
  {
    path: 'artifacts/templates/new',
    title: 'New template · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/artifacts/new-template').then((m) => m.NewTemplate),
  },
  {
    path: 'artifacts/templates/:kind/:slug',
    title: 'Template · gangway',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/artifacts/template-detail').then((m) => m.TemplateDetail),
  },
  {
    path: 'artifacts/themes/:id',
    title: 'Theme · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/artifacts/theme-editor').then((m) => m.ThemeEditor),
  },
  { path: 'templates', redirectTo: 'artifacts?tab=templates' },
  {
    path: 'settings',
    title: 'Settings · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/settings/settings').then((m) => m.SettingsPage),
  },
  {
    path: 'admin',
    title: 'Admin · gangway',
    canActivate: [authGuard],
    loadComponent: () => import('./features/admin/admin-page').then((m) => m.AdminPage),
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
