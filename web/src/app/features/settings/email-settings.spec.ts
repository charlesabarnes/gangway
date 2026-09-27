import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, type Rendered } from '../../../testing/render';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { EmailSettings } from './email-settings';

const setting = (key: string, value: unknown, o: Partial<SettingView> = {}): SettingView => ({
  key,
  source: 'database',
  managedByConfig: false,
  secret: false,
  value,
  set: value !== '' && value !== null,
  ...o,
});

@Component({
  imports: [EmailSettings],
  template: `<app-email-settings [settings]="settings()" [(saving)]="saving" />`,
})
class Host {
  readonly settings = signal<SettingView[]>([]);
  readonly saving = signal<string | null>(null);
}

async function open(url: boolean, from: string) {
  const r = await render(Host);
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } },
    permissions: ['settings.read', 'settings.write'],
  });
  await loading;
  r.fixture.componentInstance.settings.set([
    setting('mail.smtp.url', null, { secret: true, set: url }),
    setting('mail.from', from),
  ]);
  await r.settle();
  return r;
}

const type = (r: Rendered<unknown>, id: string, v: string) => {
  const i = r.byTestId(id) as HTMLInputElement;
  i.value = v;
  i.dispatchEvent(new Event('input'));
};

describe('Admin · Server · Email', () => {
  it('saves a new URL and From together, and never shows the saved URL', async () => {
    const r = await open(false, '');
    expect(r.text('email-status')).toContain('Not set up');
    expect(r.byTestId('email-test')).toBeNull();
    type(r, 'smtp-url', 'smtp://u:p@smtp.example.com:587');
    type(r, 'mail-from', 'gangway <noreply@example.com>');
    await r.settle();
    (r.byTestId('save-email') as HTMLButtonElement).click();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/settings' });
    expect(req.request.body).toEqual({
      values: {
        'mail.smtp.url': 'smtp://u:p@smtp.example.com:587',
        'mail.from': 'gangway <noreply@example.com>',
      },
    });
    req.flush({ settings: [] });
    await r.settle();
    expect((r.byTestId('smtp-url') as HTMLInputElement).value).toBe('');
    expect(r.text('email-status')).toContain('gangway <noreply@example.com>');
    expect((r.byTestId('test-to') as HTMLInputElement).value).toBe('ada@example.com');
  });

  it('sends a test, and shows the relay refusal in its own words', async () => {
    const r = await open(true, 'noreply@example.com');
    r.byTestId('email-test')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const req = r.http.expectOne({ method: 'POST', url: '/v1/settings/mail/test' });
    expect(req.request.body).toEqual({ to: 'ada@example.com' });
    req.flush(
      {
        title: 'unprocessable',
        status: 422,
        detail: 'the mail server refused: Invalid login: 535',
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await r.settle();
    expect(r.text('test-error')).toContain('Invalid login: 535');
  });

  it('can stop sending email', async () => {
    const r = await open(true, 'noreply@example.com');
    (r.byTestId('remove-email') as HTMLButtonElement).click();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/settings' });
    expect(req.request.body).toEqual({ values: { 'mail.smtp.url': '' } });
    req.flush({ settings: [] });
    await r.settle();
    expect(r.text('email-status')).toContain('Not set up');
  });
});
