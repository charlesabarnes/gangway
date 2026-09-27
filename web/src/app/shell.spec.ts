import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render } from '../testing/render';
import { App } from './app';
import { AuthService } from './core/auth.service';
import type { SessionInfo } from './core/api.types';

@Component({ template: '' })
class Blank {}

const ADA: SessionInfo = {
  authenticated: true,
  setupRequired: false,
  user: { id: 'u1', email: 'ada@example.com', role: { id: 'member', name: 'member' } },
  permissions: ['previews.read'],
};
const ROUTES = [
  { path: 'login', component: Blank },
  { path: 'previews', component: Blank },
  { path: 'account', component: Blank },
];

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
  it('shows who is logged in and their role, with a menu under it', async () => {
    const r = await shell(ADA);
    const who = r.byTestId('who')!;
    expect(who.querySelectorAll('span')[0]!.textContent).toBe('ada@example.com');
    expect(who.querySelectorAll('span')[1]!.textContent).toBe('member');
    expect(who.getAttribute('aria-expanded')).toBe('false');
    expect(r.byTestId('user-menu')!.hidden).toBe(true);

    who.click();
    await r.settle();
    expect(who.getAttribute('aria-expanded')).toBe('true');
    expect(r.byTestId('user-menu')!.hidden).toBe(false);
    expect(r.byTestId('menu-account')!.getAttribute('href')).toBe('/account');
    expect(r.byTestId('user-menu')!.querySelector('[data-testid="theme"]')).not.toBeNull();
  });

  it('closes the menu on Escape, on a click elsewhere, and on navigation', async () => {
    const r = await shell(ADA);
    const menu = () => r.byTestId('user-menu')!;
    const open = async () => {
      r.byTestId('who')!.click();
      await r.settle();
      expect(menu().hidden).toBe(false);
    };

    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await r.settle();
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(r.byTestId('who'));

    await open();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await r.settle();
    expect(menu().hidden).toBe(true);

    await open();
    r.byTestId('menu-account')!.click();
    await r.until(() => TestBed.inject(Router).url === '/account', 'navigation to /account');
    expect(menu().hidden).toBe(true);
  });

  it('shows Admin only to a role that can read users, roles or the audit log', async () => {
    const member = await shell(ADA);
    expect(member.byTestId('nav-admin')).toBeNull();
    TestBed.resetTestingModule();

    const r = await shell({ ...ADA, permissions: ['previews.read', 'audit.read'] });
    expect(r.byTestId('nav-admin')!.getAttribute('href')).toBe('/admin');
  });

  it('Previews, the home page, is the first link in the nav', async () => {
    const r = await shell(ADA);
    const first = r.el.querySelector('nav[aria-label="Main"] a')!;
    expect(first.getAttribute('data-testid')).toBe('nav-previews');
    expect(first.getAttribute('href')).toBe('/previews');
  });

  it('has no header for someone who is not signed in', async () => {
    const r = await shell({ authenticated: false, setupRequired: false });
    expect(r.el.querySelector('header')).toBeNull();
  });

  it('hides the header on /login even in the instant before the session is cleared', async () => {
    const r = await shell(ADA);
    await TestBed.inject(Router).navigateByUrl('/login');
    await r.settle();
    expect(r.el.querySelector('header')).toBeNull();
  });

  it('log out ends the session and goes to login even if the server is unreachable', async () => {
    const r = await shell(ADA);
    r.byTestId('who')!.click();
    await r.settle();
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
    r.http
      .expectOne('/healthz')
      .flush({ ok: false, draining: true }, { status: 503, statusText: 'x' });
    const loading = TestBed.inject(AuthService).refresh();
    r.http.expectOne('/v1/auth/session').flush(ADA);
    await loading;
    await r.settle();
    expect(r.text('health')).toBe('shutting down');
  });
});
