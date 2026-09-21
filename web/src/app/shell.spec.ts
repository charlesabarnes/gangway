import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render } from '../testing/render';
import { App } from './app';
import { AuthService } from './core/auth.service';
import type { SessionInfo } from './core/api.types';

@Component({ template: '' })
class Blank {}

const ADA: SessionInfo = { authenticated: true, setupRequired: false, user: { id: 'u1', email: 'ada@example.com', role: { id: 'member', name: 'member' } }, permissions: ['previews.read'] };
const ROUTES = [{ path: 'login', component: Blank }, { path: 'previews', component: Blank }, { path: 'account', component: Blank }];

async function shell(session: SessionInfo | null) {
  const r = await render(App, { routes: ROUTES });
  r.http.expectOne('/healthz').flush({ ok: true, routes: 0 });
  if (session) {
    const loading = TestBed.inject(AuthService).refresh();
    r.http.expectOne('/v1/auth/session').flush(session);
    await loading;
  }
  await r.settle();
  return r;
}

describe('the app shell', () => {
  it('shows who is logged in, with their ROLE NAME as the server gave it, and links to their account', async () => {
    const r = await shell(ADA);
    // Two spans; the gap between them is CSS, so the text runs together.
    expect(r.byTestId('who')!.querySelectorAll('span')[0]!.textContent).toBe('ada@example.com');
    expect(r.byTestId('who')!.querySelectorAll('span')[1]!.textContent).toBe('member');
    expect(r.byTestId('who')!.getAttribute('href')).toBe('/account');
  });

  it('has no header for someone who is not in: login and setup bring their own frame', async () => {
    const r = await shell({ authenticated: false, setupRequired: false });
    expect(r.el.querySelector('header')).toBeNull();
  });

  it('hides the header on /login even in the instant before the session is cleared', async () => {
    const r = await shell(ADA);
    await TestBed.inject(Router).navigateByUrl('/login');
    await r.settle();
    expect(r.el.querySelector('header')).toBeNull();
  });

  it('log out ends the session and goes to login -- even if the server is unreachable', async () => {
    const r = await shell(ADA);
    r.byTestId('logout')!.click();
    r.http.expectOne('/v1/auth/logout').error(new ProgressEvent('error'));
    await r.until(() => TestBed.inject(Router).url === '/login', 'navigation to /login');
    expect(TestBed.inject(AuthService).authenticated()).toBe(false);
    expect(TestBed.inject(Router).url).toBe('/login');
  });

  it('says so when the server is draining or gone, and says nothing when it is fine', async () => {
    const fine = await shell(ADA);
    expect(fine.byTestId('health')).toBeNull();
    TestBed.resetTestingModule();

    const r = await render(App, { routes: ROUTES });
    r.http.expectOne('/healthz').flush({ ok: false, draining: true }, { status: 503, statusText: 'x' });
    const loading = TestBed.inject(AuthService).refresh();
    r.http.expectOne('/v1/auth/session').flush(ADA);
    await loading; await r.settle();
    expect(r.text('health')).toBe('shutting down');
  });
});
