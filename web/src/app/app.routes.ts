import { Routes } from '@angular/router';
import { Home } from './home';

export const routes: Routes = [
  { path: '', component: Home, title: 'gangway' },
  // The server answers every unknown path on the `app` surface with index.html (SPA
  // fallback), so an unknown path is the router's to handle, not a 404 page's.
  { path: '**', redirectTo: '' },
];
