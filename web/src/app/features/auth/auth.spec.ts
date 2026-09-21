import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { render, type Rendered } from '../../../testing/render';
import { Login } from './login';
import { Setup } from './setup';

@Component({ template: '' })
class Blank {}

const USER = { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } };
const ROUTES = [{ path: 'previews/:id', component: Blank }, { path: '', component: Blank }];

const routeWith = (query: Record<string, string>) => ({ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } });

function type(r: Rendered<unknown>, id: string, value: string): void {
  const input = r.byTestId(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
const submit = async (r: Rendered<unknown>) => { r.el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle(); };

describe('Login', () => {
  const open = (query: Record<string, string> = {}) => render(Login, { routes: ROUTES, providers: [routeWith(query)] });

  it('logs in and goes where the person was headed', async () => {
    const r = await open({ returnUrl: '/previews/01ABC' });
    type(r, 'email', '  ada@example.com ');
    type(r, 'password', 'a long enough passphrase');
    await submit(r);
    const req = r.http.expectOne('/v1/auth/login');
    expect(req.request.body).toEqual({ email: 'ada@example.com', password: 'a long enough passphrase' });
    req.flush({ user: USER, permissions: ['previews.read'] });
    await r.settle(); await r.settle();
    expect(TestBed.inject(Router).url).toBe('/previews/01ABC');
  });

  it('never follows a returnUrl off this origin', async () => {
    const r = await open({ returnUrl: '//evil.example/steal' });
    type(r, 'email', 'ada@example.com'); type(r, 'password', 'a long enough passphrase');
    await submit(r);
    r.http.expectOne('/v1/auth/login').flush({ user: USER, permissions: [] });
    await r.settle(); await r.settle();
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('a 401 says one thing -- the same thing the server says for every kind of failure -- and clears the password', async () => {
    const r = await open();
    type(r, 'email', 'ada@example.com'); type(r, 'password', 'not the password');
    await submit(r);
    r.http.expectOne('/v1/auth/login').flush({ title: 'unauthorized', detail: 'wrong email or password' }, { status: 401, statusText: 'x' });
    await r.settle();
    expect(r.text('error')).toBe('Wrong email or password.');
    expect((r.byTestId('password') as HTMLInputElement).value).toBe('');
    expect((r.byTestId('email') as HTMLInputElement).value).toBe('ada@example.com');
  });

  it('a lockout disables the button and counts down from Retry-After, then lets you try again', async () => {
    // Only the countdown's interval is faked: the test helpers wait on real timeouts.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const r = await open();
      type(r, 'email', 'ada@example.com'); type(r, 'password', 'x');
      await submit(r);
      r.http.expectOne('/v1/auth/login').flush({ title: 'rate limited', retryAfter: 90 }, { status: 429, statusText: 'x', headers: { 'retry-after': '90' } });
      await r.settle();
      const button = r.byTestId('submit') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(r.text('submit')).toBe('Try again in 1m 30s');

      vi.advanceTimersByTime(31_000); r.fixture.detectChanges();
      expect(r.text('submit')).toBe('Try again in 59s');

      // Submitting while locked asks the server nothing.
      type(r, 'password', 'y'); await submit(r);
      r.http.expectNone('/v1/auth/login');

      vi.advanceTimersByTime(60_000); r.fixture.detectChanges();
      expect(button.disabled).toBe(false);
      expect(r.text('submit')).toBe('Log in');
      expect(r.byTestId('error')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('an empty form asks the server nothing', async () => {
    const r = await open();
    await submit(r);
    r.http.expectNone('/v1/auth/login');
    expect(r.text('error')).toBe('Enter your email and password.');
  });

  it('an unexpected failure shows the request id, which is what to quote when asking why', async () => {
    const r = await open();
    type(r, 'email', 'ada@example.com'); type(r, 'password', 'x');
    await submit(r);
    r.http.expectOne('/v1/auth/login').flush({ title: 'internal', detail: 'internal error', requestId: '01REQ' }, { status: 500, statusText: 'x' });
    await r.settle();
    expect(r.text('error')).toContain('01REQ');
  });

  it('password managers can find the fields', async () => {
    const r = await open();
    expect(r.byTestId('email')!.getAttribute('autocomplete')).toBe('username');
    expect(r.byTestId('password')!.getAttribute('autocomplete')).toBe('current-password');
  });
});

describe('Setup', () => {
  const open = (query: Record<string, string> = { token: 'gw_setup_abc' }) => render(Setup, { routes: ROUTES, providers: [routeWith(query)] });
  const fill = (r: Rendered<unknown>, pw = 'a long enough passphrase', again = pw) => { type(r, 'email', 'ada@example.com'); type(r, 'password', pw); type(r, 'confirm', again); };

  it('without the link there is no form, only where to find it', async () => {
    const r = await open({});
    expect(r.el.querySelector('form')).toBeNull();
    expect(r.text('no-token')).toContain('docker logs gangway');
  });

  it('posts the token from the URL with the new account, then goes in', async () => {
    const r = await open();
    fill(r); await r.settle();
    await submit(r);
    const req = r.http.expectOne('/v1/auth/setup');
    expect(req.request.body).toEqual({ token: 'gw_setup_abc', email: 'ada@example.com', password: 'a long enough passphrase' });
    req.flush({ user: USER, permissions: ['users.manage'] }, { status: 201, statusText: 'Created' });
    await r.settle(); await r.settle();
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('the button stays off until the password is long enough AND typed the same twice', async () => {
    const r = await open();
    const button = () => r.byTestId('submit') as HTMLButtonElement;
    fill(r, 'short', 'short'); await r.settle();
    expect(button().disabled).toBe(true);
    fill(r, 'a long enough passphrase', 'a long enough passphrasE'); await r.settle();
    expect(button().disabled).toBe(true);
    expect(r.text('mismatch')).toBe('These do not match yet.');
    fill(r); await r.settle();
    expect(button().disabled).toBe(false);
    expect(r.byTestId('mismatch')).toBeNull();
  });

  it('a dead link (403) explains that every restart prints a new one', async () => {
    const r = await open();
    fill(r); await r.settle(); await submit(r);
    r.http.expectOne('/v1/auth/setup').flush({ title: 'forbidden' }, { status: 403, statusText: 'x' });
    await r.settle();
    expect(r.text('error')).toContain('not valid');
    expect(r.text('error')).toContain('every time gangway starts');
  });

  it('already set up (404), and a server-side validation failure (422), each say what happened', async () => {
    const r = await open();
    fill(r); await r.settle(); await submit(r);
    r.http.expectOne('/v1/auth/setup').flush({ title: 'not found' }, { status: 404, statusText: 'x' });
    await r.settle();
    expect(r.text('error')).toContain('already been completed');

    await submit(r);
    r.http.expectOne('/v1/auth/setup').flush({ title: 'unprocessable', issues: [{ path: 'email', message: 'Invalid email' }] }, { status: 422, statusText: 'x' });
    await r.settle();
    expect(r.text('error')).toBe('email: Invalid email');
  });

  it('password managers are told these are NEW passwords', async () => {
    const r = await open();
    expect(r.byTestId('password')!.getAttribute('autocomplete')).toBe('new-password');
    expect(r.byTestId('confirm')!.getAttribute('autocomplete')).toBe('new-password');
  });
});
