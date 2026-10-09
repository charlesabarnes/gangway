import { TestBed } from '@angular/core/testing';
import { render } from '../../../testing/render';
import { PERMISSIONS, type Permission, type SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { WatermarkSettings } from './watermark-settings';

const setting = (key: string, value: unknown): SettingView => ({
  key,
  value,
  source: 'database',
  managedByConfig: false,
  secret: false,
  set: true,
});

async function open(permissions: Permission[], settings: SettingView[]) {
  const r = await render(WatermarkSettings, { inputs: { saving: null, settings } });
  const loading = TestBed.inject(AuthService).refresh();
  r.http
    .expectOne('/v1/auth/session')
    .flush({ authenticated: true, setupRequired: false, permissions });
  await loading;
  await r.settle();
  return r;
}

describe('WatermarkSettings', () => {
  it("lets another org change its own mark, and keeps the server's report link from it", async () => {
    const r = await open(
      ['settings.org_read', 'settings.org_write'],
      [setting('previews.watermark', true), setting('previews.watermark.link', '')],
    );
    expect(r.byTestId('watermark-report')).toBeNull();
    const on = r.byTestId('watermark-on')?.querySelector('input') as HTMLInputElement;
    expect(on.disabled).toBe(false);
    on.click();
    await r.settle();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/settings' });
    expect(req.request.body).toEqual({ values: { 'previews.watermark': false } });
  });

  it("shows the server's report link to whoever holds the server's settings", async () => {
    const r = await open(
      [...PERMISSIONS],
      [setting('previews.watermark.report', 'https://r.example.com')],
    );
    expect((r.byTestId('watermark-report') as HTMLInputElement).value).toBe(
      'https://r.example.com',
    );
  });
});
