import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import contract from '../../../testing/fixtures/contract.json';
import { render } from '../../../testing/render';
import type { ConsentRequest } from '../../core/api.types';
import { HARD_NAVIGATE } from '../../core/auth.guard';
import { Connect } from './connect';

const request = (over: Partial<ConsentRequest> = {}): ConsentRequest => ({
  ...(contract.oauthRequest as ConsentRequest),
  ...over,
});

async function open(query: Record<string, string> = { request: 'req-1' }) {
  const went: string[] = [];
  const r = await render(Connect, {
    providers: [
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
      },
      { provide: HARD_NAVIGATE, useValue: (u: string) => went.push(u) },
    ],
  });
  return { r, went };
}

describe('Connect (OAuth consent)', () => {
  it('says who is asking and where the answer goes; approving posts the chosen scopes and leaves for the client', async () => {
    const { r, went } = await open();
    r.http.expectOne('/v1/oauth/requests/req-1').flush({ request: request() });
    await r.settle();
    expect(r.text('client-name')).toBe('Claude');
    expect(r.text('client-host')).toBe('claude.ai');
    expect(r.text('redirect-host')).toBe('claude.ai');
    expect((r.byTestId('scope-read') as HTMLInputElement).checked).toBe(true);
    expect((r.byTestId('scope-deploy') as HTMLInputElement).checked).toBe(true);

    // Down to read only, then connect.
    (r.byTestId('scope-deploy') as HTMLInputElement).dispatchEvent(new Event('change'));
    await r.settle();
    (r.byTestId('approve') as HTMLButtonElement).click();
    await r.settle();
    const req = r.http.expectOne({
      method: 'POST',
      url: '/v1/oauth/requests/Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4',
    });
    expect(req.request.body).toEqual({ approve: true, scopes: ['read'] });
    req.flush(contract.oauthDecided);
    await r.until(() => went.length === 1, 'the navigation');
    expect(went[0]).toBe(contract.oauthDecided.redirect);
  });

  it('a scope the role does not cover is shown, disabled and unchecked', async () => {
    const { r } = await open();
    r.http
      .expectOne('/v1/oauth/requests/req-1')
      .flush({ request: request({ grantable: ['read'] }) });
    await r.settle();
    const deploy = r.byTestId('scope-deploy') as HTMLInputElement;
    expect(deploy.disabled).toBe(true);
    expect(deploy.checked).toBe(false);
    expect(r.el.textContent).toContain('Your role does not cover this.');
  });

  it('cancel goes back to the client too, as a refusal', async () => {
    const { r, went } = await open();
    r.http.expectOne('/v1/oauth/requests/req-1').flush({ request: request() });
    await r.settle();
    (r.byTestId('deny') as HTMLButtonElement).click();
    await r.settle();
    const req = r.http.expectOne({
      method: 'POST',
      url: '/v1/oauth/requests/Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4',
    });
    expect(req.request.body).toEqual({ approve: false });
    req.flush({ redirect: 'https://claude.ai/api/mcp/auth_callback?error=access_denied' });
    await r.until(() => went.length === 1, 'the navigation');
  });

  it('an expired request says so; no request in the link says so without asking', async () => {
    const { r } = await open();
    r.http.expectOne('/v1/oauth/requests/req-1').flush(
      {
        title: 'not found',
        detail: 'this authorization request has expired or was already answered',
      },
      { status: 404, statusText: 'x' },
    );
    await r.until(() => r.byTestId('error') !== null, 'the error');
    expect(r.text('error')).toContain('expired');

    TestBed.resetTestingModule();
    const none = await open({});
    await none.r.until(() => none.r.byTestId('error') !== null, 'the error');
    none.r.http.expectNone(() => true);
    expect(none.r.text('error')).toContain('missing its request');
  });
});
