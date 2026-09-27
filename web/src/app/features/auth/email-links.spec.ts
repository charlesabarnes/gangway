import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { render, type Rendered } from '../../../testing/render';
import { AuthService } from '../../core/auth.service';
import { ForgotPassword } from './forgot-password';
import { Login } from './login';
import { SetPassword } from './set-password';

@Component({ template: '' })
class Blank {}

const ROUTES = [
  { path: '', component: Blank },
  { path: 'login', component: Blank },
  { path: 'forgot-password', component: Blank },
];
const USER = { id: 'u2', email: 'bob@example.com', role: { id: 'member', name: 'member' } };
const TOKEN = 'A'.repeat(43);

const routeWith = (query: Record<string, string>) => ({
  provide: ActivatedRoute,
  useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
});

function type(r: Rendered<unknown>, id: string, value: string): void {
  const input = r.byTestId(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
const submit = async (r: Rendered<unknown>) => {
  r.el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await r.settle();
};

describe('Login: forgot password', () => {
  async function open(passwordReset: boolean) {
    const r = await render(Login, { routes: ROUTES, providers: [routeWith({})] });
    const loading = TestBed.inject(AuthService).refresh();
    r.http
      .expectOne('/v1/auth/session')
      .flush({ authenticated: false, setupRequired: false, passwordReset });
    await loading;
    await r.settle();
    return r;
  }

  it('is offered only when the server can email a link, carrying the typed address', async () => {
    expect((await open(false)).byTestId('forgot')).toBeNull();
    TestBed.resetTestingModule();
    const r = await open(true);
    type(r, 'email', ' bob@example.com ');
    await r.settle();
    expect(r.byTestId('forgot')!.getAttribute('href')).toBe(
      '/forgot-password?email=bob@example.com',
    );
  });
});

describe('ForgotPassword', () => {
  const open = (query: Record<string, string> = {}) =>
    render(ForgotPassword, { routes: ROUTES, providers: [routeWith(query)] });

  it('asks for a link and says the same thing whether or not the account exists', async () => {
    const r = await open({ email: 'bob@example.com' });
    expect((r.byTestId('email') as HTMLInputElement).value).toBe('bob@example.com');
    await submit(r);
    const req = r.http.expectOne('/v1/auth/password-reset');
    expect(req.request.body).toEqual({ email: 'bob@example.com' });
    req.flush(null, { status: 202, statusText: 'Accepted' });
    await r.settle();
    expect(r.byTestId('sent')!.textContent).toContain('If bob@example.com has an account here');
  });

  it('asked again too soon, it says a link was just sent', async () => {
    const r = await open({ email: 'bob@example.com' });
    await submit(r);
    r.http
      .expectOne('/v1/auth/password-reset')
      .flush(
        { title: 'rate limited', status: 429, detail: 'x' },
        { status: 429, statusText: 'Too Many Requests' },
      );
    await r.settle();
    expect(r.byTestId('error')!.textContent).toContain('A link was sent a moment ago');
  });
});

describe('SetPassword', () => {
  afterEach(() => history.replaceState(null, '', '/'));

  async function open(link: { email: string; purpose: 'invite' | 'reset' } | 404) {
    history.replaceState(null, '', `/set-password#${TOKEN}`);
    const r = await render(SetPassword, { routes: ROUTES });
    expect(location.hash).toBe('');
    const req = r.http.expectOne('/v1/auth/link');
    expect(req.request.body).toEqual({ token: TOKEN });
    if (link === 404)
      req.flush(
        { title: 'not found', status: 404, detail: 'gone' },
        { status: 404, statusText: 'Not Found' },
      );
    else req.flush(link);
    await r.settle();
    return r;
  }

  it('an invitation: choose a password, and you are logged in', async () => {
    const r = await open({ email: 'bob@example.com', purpose: 'invite' });
    expect(r.el.querySelector('h1')!.textContent).toContain('Welcome to gangway');
    expect(r.el.textContent).toContain('bob@example.com');
    type(r, 'password', 'a brand new passphrase');
    type(r, 'confirm', 'a brand new passphrase');
    await r.settle();
    await submit(r);
    const req = r.http.expectOne('/v1/auth/link/redeem');
    expect(req.request.body).toEqual({ token: TOKEN, password: 'a brand new passphrase' });
    req.flush({ user: USER, permissions: ['previews.read'] });
    await r.until(() => TestBed.inject(AuthService).authenticated(), 'the login');
    await r.settle();
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('a reset link says it logs you out elsewhere', async () => {
    const r = await open({ email: 'bob@example.com', purpose: 'reset' });
    expect(r.el.querySelector('h1')!.textContent).toContain('Choose a new password');
    expect(r.el.textContent).toContain('logs you out everywhere');
  });

  it('a used or expired link offers a new one', async () => {
    const r = await open(404);
    expect(r.byTestId('gone')).not.toBeNull();
    expect(r.byTestId('password')).toBeNull();
    expect(r.byTestId('again')!.getAttribute('href')).toBe('/forgot-password');
  });
});
