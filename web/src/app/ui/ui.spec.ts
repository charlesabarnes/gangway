import { TestBed } from '@angular/core/testing';
import { PREVIEW_STATES } from '../core/api.types';
import { render } from '../../testing/render';
import { ConnectionDot } from './connection-dot';
import { relativeTime } from './relative-time.pipe';
import { StateBadge } from './state-badge';
import { ThemeToggle } from './theme-toggle';
import { THEME_KEY } from '../core/theme';
import { ToastService, Toasts } from './toast';

describe('StateBadge', () => {
  it('says every state in words, not colour alone', async () => {
    for (const state of PREVIEW_STATES) {
      const r = await render(StateBadge, { inputs: { state } });
      expect(r.el.textContent?.trim()).toBe(state);
      expect(r.el.querySelector('[aria-hidden="true"]')).not.toBeNull();
      TestBed.resetTestingModule();
    }
  });
});

describe('ConnectionDot', () => {
  it('is silent when idle, and announces the rest politely', async () => {
    expect(
      (await render(ConnectionDot, { inputs: { status: 'idle' } })).byTestId('connection'),
    ).toBeNull();
    TestBed.resetTestingModule();
    const r = await render(ConnectionDot, { inputs: { status: 'reconnecting' } });
    expect(r.text('connection')).toBe('reconnecting…');
    expect(r.byTestId('connection')!.getAttribute('role')).toBe('status');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  it.each([
    ['2026-09-21T11:59:55Z', 'just now'],
    ['2026-09-21T11:59:15Z', '45 s ago'],
    ['2026-09-21T11:55:00Z', '5 min ago'],
    ['2026-09-21T09:00:00Z', '3 h ago'],
    ['2026-09-18T12:00:00Z', '3 d ago'],
    ['2026-09-21T12:30:00Z', 'in 30 min'],
    ['2026-09-28T12:00:00Z', 'in 7 d'],
    [null, ''],
    ['not a date', ''],
  ])('%s -> %s', (iso, want) => expect(relativeTime(iso, now)).toBe(want));
});

describe('toasts', () => {
  it('an error stays until dismissed and shows the request id; info leaves by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      TestBed.configureTestingModule({ imports: [Toasts] });
      const fixture = TestBed.createComponent(Toasts);
      const svc = TestBed.inject(ToastService);
      svc.info('Copied');
      svc.problem('Could not destroy gw-x', {
        status: 403,
        title: 'forbidden',
        detail: 'requires the "previews.destroy" permission',
        requestId: '01REQ',
        retryAfter: null,
        issues: [],
      });
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelectorAll('[data-testid="toast"]')).toHaveLength(2);
      expect(el.textContent).toContain('request 01REQ');
      expect(el.querySelector('[role="alert"]')!.textContent).toContain('Could not destroy gw-x');

      vi.advanceTimersByTime(5_000);
      fixture.detectChanges();
      expect(el.querySelectorAll('[data-testid="toast"]')).toHaveLength(1);
      (el.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(el.querySelectorAll('[data-testid="toast"]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ThemeToggle', () => {
  afterEach(() => localStorage.removeItem(THEME_KEY));

  it('overrides the system, remembers it, and goes back to following it', async () => {
    const r = await render(ThemeToggle);
    expect(r.byTestId('theme-system')!.getAttribute('aria-pressed')).toBe('true');

    r.byTestId('theme-dark')!.click();
    await r.settle();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(r.byTestId('theme-dark')!.getAttribute('aria-pressed')).toBe('true');

    r.byTestId('theme-light')!.click();
    await r.settle();
    expect(document.documentElement.dataset['theme']).toBe('light');

    r.byTestId('theme-system')!.click();
    await r.settle();
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('starts from the stored choice', async () => {
    localStorage.setItem(THEME_KEY, 'dark');
    const r = await render(ThemeToggle);
    expect(r.byTestId('theme-dark')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});
