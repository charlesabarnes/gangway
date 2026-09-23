import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { apiInterceptor } from './api.interceptor';
import { anonymousOnly, authGuard, safeReturnUrl, setupOnly } from './auth.guard';
import { AuthService } from './auth.service';
import type { SessionInfo } from './api.types';

@Component({ template: '' })
class Blank {}

const ADA: SessionInfo = {
  authenticated: true,
  setupRequired: false,
  user: { id: 'u1', email: 'ada@example.com', role: { id: 'member', name: 'member' } },
  permissions: ['previews.read', 'previews.destroy'],
};
const ANON: SessionInfo = { authenticated: false, setupRequired: false };
const FIRST_RUN: SessionInfo = { authenticated: false, setupRequired: true };

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'login', component: Blank, canActivate: [anonymousOnly] },
        { path: 'setup', component: Blank, canActivate: [setupOnly] },
        { path: 'previews', component: Blank, canActivate: [authGuard] },
        { path: 'previews/:id', component: Blank, canActivate: [authGuard] },
        { path: '', pathMatch: 'full', redirectTo: 'previews' },
      ]),
      provideHttpClient(withInterceptors([apiInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  const auth = TestBed.inject(AuthService);
  /** Navigate, answer the session question if it is asked, and report where we ended up. */
  const go = async (url: string, session?: SessionInfo) => {
    const nav = router.navigateByUrl(url);
    // The router reaches the guard a few turns after navigateByUrl returns; wait for the
    // question to be asked rather than guessing how many.
    for (let i = 0; session && i < 50; i++) {
      const [asked] = http.match('/v1/auth/session');
      if (asked) {
        asked.flush(session);
        break;
      }
      await new Promise((r) => setTimeout(r));
    }
    await nav;
    return router.url;
  };
  return { http, router, auth, go };
}

describe('AuthService', () => {
  it('asks the server ONCE, however many callers want the answer at the same moment', async () => {
    const { auth, http } = setup();
    const all = Promise.all([auth.ensureLoaded(), auth.ensureLoaded(), auth.ensureLoaded()]);
    http.expectOne('/v1/auth/session').flush(ADA);
    await all;
    await auth.ensureLoaded();
    http.verify();
    expect(auth.user()?.email).toBe('ada@example.com');
  });

  it('gates on permissions, not on the role name', async () => {
    const { auth, http } = setup();
    const p = auth.ensureLoaded();
    http.expectOne('/v1/auth/session').flush(ADA);
    await p;
    expect(auth.can('previews.destroy')).toBe(true);
    expect(auth.can('users.manage')).toBe(false);
  });

  it('refresh() picks up a permission the operator took away under an open tab', async () => {
    const { auth, http } = setup();
    const p = auth.ensureLoaded();
    http.expectOne('/v1/auth/session').flush(ADA);
    await p;
    const r = auth.refresh();
    http.expectOne('/v1/auth/session').flush({ ...ADA, permissions: ['previews.read'] });
    await r;
    expect(auth.can('previews.destroy')).toBe(false);
  });

  it('an unreachable server is "unknown", not "logged out": anonymous, with the reason kept', async () => {
    const { auth, http } = setup();
    const p = auth.ensureLoaded();
    http.expectOne('/v1/auth/session').error(new ProgressEvent('error'));
    await p;
    expect(auth.authenticated()).toBe(false);
    expect(auth.unreachable()).toBe(true);
  });

  it('login and setup take the session from the response; logout clears it even if the request fails', async () => {
    const { auth, http } = setup();
    const login = auth.login('ada@example.com', 'a long enough passphrase');
    const req = http.expectOne('/v1/auth/login');
    expect(req.request.body).toEqual({
      email: 'ada@example.com',
      password: 'a long enough passphrase',
    });
    req.flush({ user: ADA.authenticated ? ADA.user : null, permissions: ['previews.read'] });
    await login;
    expect(auth.authenticated()).toBe(true);
    expect(auth.can('previews.read')).toBe(true);

    const out = auth.logout();
    http.expectOne('/v1/auth/logout').flush(null, { status: 500, statusText: 'x' });
    await out.catch(() => {});
    expect(auth.authenticated()).toBe(false);
  });
});

describe('guards', () => {
  it('logged in: through', async () =>
    expect(await setup().go('/previews', ADA)).toBe('/previews'));

  it('anonymous: to login, remembering where you were going', async () => {
    expect(await setup().go('/previews/01ABC', ANON)).toBe('/login?returnUrl=%2Fpreviews%2F01ABC');
  });

  it('first run: to setup, from anywhere -- including the login page', async () => {
    expect(await setup().go('/previews', FIRST_RUN)).toBe('/setup');
    TestBed.resetTestingModule();
    expect(await setup().go('/login', FIRST_RUN)).toBe('/setup');
  });

  it('the login page sends a logged-in person onward, to a SAFE returnUrl only', async () => {
    expect(await setup().go('/login?returnUrl=%2Fpreviews%2F01ABC', ADA)).toBe('/previews/01ABC');
    TestBed.resetTestingModule();
    expect(await setup().go('/login?returnUrl=%2F%2Fevil.example', ADA)).toBe('/previews');
  });

  it('setup exists exactly while there are no accounts', async () => {
    expect(await setup().go('/setup?token=x', FIRST_RUN)).toBe('/setup?token=x');
    TestBed.resetTestingModule();
    expect(await setup().go('/setup?token=x', ANON)).toBe('/login');
    TestBed.resetTestingModule();
    expect(await setup().go('/setup?token=x', ADA)).toBe('/previews');
  });
});

describe('safeReturnUrl', () => {
  it.each([
    ['/previews/01ABC', '/previews/01ABC'],
    ['/previews?state=awake', '/previews?state=awake'],
    ['//evil.example', '/'],
    ['https://evil.example', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['', '/'],
    [null, '/'],
    ['/login', '/'],
    ['/login?returnUrl=/login', '/'],
    ['/setup?token=x', '/'],
  ])('%s -> %s', (raw, want) => expect(safeReturnUrl(raw)).toBe(want));
});

describe('apiInterceptor', () => {
  const loggedInAt = async (url: string) => {
    const t = setup();
    await t.go(url, ADA);
    return { ...t, client: TestBed.inject(HttpClient) };
  };

  it('a 401 from the API ends the session and goes to login, remembering the page', async () => {
    const t = await loggedInAt('/previews/01ABC');
    t.client.get('/v1/previews/01ABC').subscribe({ error: () => {} });
    t.http
      .expectOne('/v1/previews/01ABC')
      .flush({ title: 'unauthorized' }, { status: 401, statusText: 'x' });
    await new Promise((r) => setTimeout(r));
    expect(t.auth.authenticated()).toBe(false);
    expect(t.router.url).toBe('/login?returnUrl=%2Fpreviews%2F01ABC');
  });

  it('a 401 from /v1/auth/login is the ANSWER (wrong password), not a lost session', async () => {
    const t = await loggedInAt('/previews');
    t.client.post('/v1/auth/login', {}).subscribe({ error: () => {} });
    t.http
      .expectOne('/v1/auth/login')
      .flush({ title: 'unauthorized' }, { status: 401, statusText: 'x' });
    await new Promise((r) => setTimeout(r));
    expect(t.auth.authenticated()).toBe(true);
    expect(t.router.url).toBe('/previews');
  });

  it('a 403 is not a 401: you are still you, you just may not do that', async () => {
    const t = await loggedInAt('/previews');
    t.client.delete('/v1/previews/x').subscribe({ error: () => {} });
    t.http
      .expectOne('/v1/previews/x')
      .flush({ title: 'forbidden' }, { status: 403, statusText: 'x' });
    await new Promise((r) => setTimeout(r));
    expect(t.auth.authenticated()).toBe(true);
    expect(t.router.url).toBe('/previews');
  });

  it('adds no CSRF header: the server checks Origin, which the browser sends by itself', async () => {
    const t = await loggedInAt('/previews');
    t.client.post('/v1/tokens', {}).subscribe();
    const req = t.http.expectOne('/v1/tokens');
    expect(req.request.headers.keys().filter((k) => /csrf|xsrf/i.test(k))).toEqual([]);
    req.flush({});
  });
});
