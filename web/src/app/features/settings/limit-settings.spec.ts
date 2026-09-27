import { TestBed } from '@angular/core/testing';
import { render } from '../../../testing/render';
import { PERMISSIONS, type SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { LimitSettings } from './limit-settings';

const setting = (key: string, value: number): SettingView => ({
  key,
  value,
  source: 'database',
  managedByConfig: false,
  secret: false,
  set: true,
});

describe('LimitSettings', () => {
  it('shows the limits and saves only what changed', async () => {
    const r = await render(LimitSettings, {
      inputs: {
        saving: null,
        settings: [
          setting('limits.requests.client', 1200),
          setting('limits.requests.preview', 12000),
          setting('limits.websockets.client', 100),
        ],
      },
    });
    const loading = TestBed.inject(AuthService).refresh();
    r.http
      .expectOne('/v1/auth/session')
      .flush({ authenticated: true, setupRequired: false, permissions: [...PERMISSIONS] });
    await loading;
    await r.settle();
    expect((r.byTestId('limits.requests.client') as HTMLInputElement).value).toBe('1200');
    const i = r.byTestId('limits.websockets.client') as HTMLInputElement;
    i.value = '5';
    i.dispatchEvent(new Event('input'));
    await r.settle();
    (r.byTestId('limits-save') as HTMLButtonElement).click();
    await r.settle();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/settings' });
    expect(req.request.body).toEqual({ values: { 'limits.websockets.client': 5 } });
    req.flush({ settings: [] });
    await r.settle();
    r.http.verify();
  });
});
