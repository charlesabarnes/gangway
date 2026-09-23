import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { FakeEventSource } from '../../../testing/fake-event-source';
import contract from '../../../testing/fixtures/contract.json';
import { render } from '../../../testing/render';
import type { Permission, Preview } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { EVENT_SOURCE_FACTORY, SSE_JITTER } from '../../core/sse.service';
import { Toasts } from '../../ui/toast';
import { FRAME } from './log-viewer';
import { PreviewDetail } from './preview-detail';

@Component({ template: '' })
class Blank {}

@Component({
  imports: [PreviewDetail, Toasts],
  template: '<app-preview-detail [id]="id" /><app-toasts />',
})
class Host {
  id = ID;
}

const ID = '01DETAIL000000000000000000';
const base: Preview = {
  ...(contract.preview as Preview),
  id: ID,
  project: 'gw-shop-pr-42',
  source: { kind: 'pr', repo: 'acme/shop', number: 42, sha: 'abc' },
  visibility: 'unlisted',
  urls: [
    { service: 'web', url: 'https://shop-pr-42.preview.example.dev/', primary: true },
    { service: 'api', url: 'https://shop-pr-42-api.preview.example.dev/', primary: false },
  ],
};

async function open(
  o: { preview?: Preview | null; permissions?: Permission[]; inList?: boolean } = {},
) {
  FakeEventSource.reset();
  const preview = o.preview === undefined ? base : o.preview;
  const r = await render(Host, {
    routes: [{ path: '**', component: Blank }],
    providers: [
      { provide: EVENT_SOURCE_FACTORY, useValue: (url: string) => new FakeEventSource(url) },
      { provide: SSE_JITTER, useValue: () => 0 },
      { provide: FRAME, useValue: (cb: () => void) => cb() },
    ],
  });
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    permissions: o.permissions ?? ['previews.read', 'previews.destroy', 'logs.read', 'events.read'],
  });
  await loading;

  r.http.expectNone(`/v1/previews/${ID}`);
  r.http
    .expectOne('/v1/previews')
    .flush({ seq: 5, previews: o.inList === false || !preview ? [] : [preview] });
  await r.settle();
  if (o.inList === false || !preview) {
    const one = r.http.expectOne(`/v1/previews/${ID}`);
    if (preview) one.flush({ preview });
    else one.flush({ title: 'not found' }, { status: 404, statusText: 'x' });
  }
  await r.settle();
  return r;
}

const answerHistory = async (
  r: Awaited<ReturnType<typeof open>>,
  events: unknown[] = [],
  builds: unknown[] = [],
) => {
  r.http.match(`/v1/previews/${ID}/events`).forEach((q) => q.flush({ events }));
  r.http.match(`/v1/previews/${ID}/builds`).forEach((q) => q.flush({ builds }));
  await r.settle();
};

describe('PreviewDetail', () => {
  beforeAll(installDialogPolyfill);

  it('shows the name, state, visibility, facts, and every URL with the primary marked', async () => {
    const r = await open();
    await answerHistory(r);
    expect(r.text('title')).toBe('shop-pr-42');
    expect(r.el.querySelector('[data-state]')!.textContent?.trim()).toBe('awake');
    expect(r.text('visibility')).toBe('unlisted');
    const rows = r.allByTestId('url-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('primary');
    expect(rows[1]!.textContent).not.toContain('primary');
    expect(rows[0]!.querySelector('a')!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(r.text('facts')).toContain('acme/shop#42');
  });

  it('shows a title over the address, and renames it', async () => {
    const r = await open({
      preview: { ...base, title: 'Shop redesign' },
      permissions: ['previews.read', 'previews.update_own'],
    });
    await answerHistory(r);
    expect(r.text('title')).toBe('Shop redesign');
    expect(r.text('slug')).toBe('shop-pr-42');

    r.byTestId('rename')!.click();
    await r.settle();
    const input = r.byTestId('title-input') as HTMLInputElement;
    expect(input.value).toBe('Shop redesign');
    input.value = 'Demo, Friday';
    input.dispatchEvent(new Event('input'));
    r.byTestId('title-save')!.click();
    await r.settle();
    const put = r.http.expectOne(`/v1/previews/${ID}/title`);
    expect(put.request.body).toEqual({ title: 'Demo, Friday' });
    put.flush({ preview: { ...base, title: 'Demo, Friday' } });
    await r.settle();
    expect(r.text('title')).toBe('Demo, Friday');
  });

  it('cannot rename without an update permission', async () => {
    const r = await open();
    await answerHistory(r);
    expect(r.byTestId('rename')).toBeNull();
    expect(r.byTestId('slug')).toBeNull();
  });

  it('does not fetch the preview again when the list already holds it', async () => {
    const r = await open();
    await answerHistory(r);
    r.http.expectNone(`/v1/previews/${ID}`);
    r.http.verify();
  });

  it('a deep link works even when the list does not hold the preview', async () => {
    const r = await open({ inList: false });
    await answerHistory(r);
    expect(r.text('title')).toBe('shop-pr-42');
  });

  it('an uploaded preview with add-ons shows its databases', async () => {
    const withDb: Preview = {
      ...base,
      source: {
        kind: 'tarball',
        uploadId: ID,
        runtime: 'node',
        addons: [{ id: 'postgres', version: '18' }],
      },
    };
    const r = await open({ preview: withDb, permissions: ['previews.read', 'previews.data'] });
    expect(r.byTestId('databases')).not.toBeNull();
  });

  it('a preview without add-ons has no Databases section', async () => {
    const r = await open();
    expect(r.byTestId('databases')).toBeNull();
  });

  it('says so when a preview does not exist, rather than loading forever', async () => {
    const r = await open({ preview: null });
    await r.until(() => r.byTestId('empty') !== null, 'the not-found state');
    expect(r.text('empty')).toContain('No such preview');
    expect(r.byTestId('loading')).toBeNull();
  });

  it('a failed preview leads with why', async () => {
    const r = await open({
      preview: {
        ...base,
        state: 'failed',
        error: 'web exited with code 1\nError: listen EADDRINUSE',
      },
    });
    await answerHistory(r);
    expect(r.text('failure')).toContain('listen EADDRINUSE');
    expect(r.byTestId('failure')!.getAttribute('role')).toBe('alert');
  });

  it('follows the live log, and its history is newest first', async () => {
    const r = await open();
    await answerHistory(
      r,
      [
        { seq: 1, type: 'preview.created', at: '2026-09-21T20:00:00.000Z' },
        {
          seq: 2,
          type: 'preview.state',
          at: '2026-09-21T20:00:01.000Z',
          state: 'starting',
          from: 'building',
        },
        {
          seq: 3,
          type: 'preview.state',
          at: '2026-09-21T20:00:02.000Z',
          state: 'awake',
          from: 'starting',
        },
      ],
      [
        {
          id: 'b1',
          previewId: ID,
          service: 'web',
          state: 'succeeded',
          startedAt: '2026-09-21T20:00:00.000Z',
          finishedAt: '2026-09-21T20:00:01.000Z',
          exitCode: 0,
        },
      ],
    );
    expect(FakeEventSource.instances.map((s) => s.url)).toContain(
      `/v1/previews/${ID}/logs?tail=2000`,
    );
    const history = Array.from(r.byTestId('events')!.querySelectorAll('li')).map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(history[0]).toContain('starting → awake');
    expect(history[2]).toContain('created');
    expect(r.text('builds')).toContain('succeeded');
  });

  it('a state change arrives live, and refreshes the history with it', async () => {
    const r = await open();
    await answerHistory(r);
    const events = FakeEventSource.instances.find((s) => s.url.startsWith('/v1/events'))!;
    events.open();
    events.emit(
      'preview.state',
      {
        previewId: ID,
        at: new Date(Date.parse(base.updatedAt) + 60_000).toISOString(),
        state: 'asleep',
        from: 'awake',
      },
      '6',
    );
    await r.settle();
    expect(r.el.querySelector('[data-state]')!.textContent?.trim()).toBe('asleep');
    expect(r.http.match(`/v1/previews/${ID}/events`)).toHaveLength(1);
  });

  it('without logs.read there is no log viewer and no log request', async () => {
    const r = await open({ permissions: ['previews.read'] });
    await answerHistory(r);
    expect(r.byTestId('log')).toBeNull();
    expect(FakeEventSource.instances.some((s) => s.url.includes('/logs'))).toBe(false);
    r.http.expectNone(`/v1/previews/${ID}/events`);
  });

  it('a destroyed preview explains that its log is gone', async () => {
    const r = await open({
      preview: { ...base, state: 'destroyed', destroyedAt: base.updatedAt },
      inList: false,
    });
    await answerHistory(r);
    expect(r.text('logs-gone')).toContain('deleted when a preview is destroyed');
    expect(r.byTestId('destroy')).toBeNull();
    expect(r.text('facts')).toContain('Destroyed');
    expect(r.text('facts')).not.toContain('Expires');
  });

  describe('destroy', () => {
    it('needs the permission', async () => {
      const r = await open({ permissions: ['previews.read', 'logs.read'] });
      await answerHistory(r);
      expect(r.byTestId('destroy')).toBeNull();
    });

    it('confirms first, then shows it going and stops offering Destroy', async () => {
      const r = await open();
      await answerHistory(r);
      (r.byTestId('destroy') as HTMLElement).click();
      await r.settle();
      expect(r.byTestId('confirm')!.textContent).toContain('Destroy shop-pr-42?');
      (r.byTestId('confirm-ok') as HTMLElement).click();
      await r.settle();
      expect(r.el.querySelector('[data-state]')!.textContent?.trim()).toBe('destroying');
      expect(r.byTestId('destroy')).toBeNull();
      r.http
        .expectOne({ method: 'DELETE', url: `/v1/previews/${ID}` })
        .flush({ preview: { ...base, state: 'destroyed' } });
      await answerHistory(r);
      expect(r.byTestId('logs-gone')).not.toBeNull();
    });

    it('a refusal rolls back and says why, with the request id', async () => {
      const r = await open();
      await answerHistory(r);
      (r.byTestId('destroy') as HTMLElement).click();
      await r.settle();
      (r.byTestId('confirm-ok') as HTMLElement).click();
      await r.settle();
      r.http.expectOne(`/v1/previews/${ID}`).flush(
        {
          title: 'conflict',
          detail: 'this preview is already being destroyed',
          requestId: '01REQ',
        },
        { status: 409, statusText: 'x' },
      );
      await r.until(() => r.byTestId('toast') !== null, 'the error toast');
      expect(r.text('toast')).toContain('already being destroyed');
      expect(r.text('toast')).toContain('01REQ');
      expect(r.el.querySelector('[data-state]')!.textContent?.trim()).toBe('awake');
    });
  });
});

describe('PreviewDetail: who can open it', () => {
  const pick = async (r: Awaited<ReturnType<typeof open>>, id: string, v: string) => {
    const el = r.byTestId(id) as HTMLSelectElement;
    el.value = v;
    el.dispatchEvent(new Event('change'));
    await r.settle();
  };
  const member: Permission[] = ['previews.read', 'previews.update_own', 'logs.read', 'events.read'];

  it('an open preview has no badge, and choosing a password generates one', async () => {
    const r = await open({ permissions: member });
    await answerHistory(r);
    expect(r.byTestId('password-badge')).toBeNull();
    expect(r.text('password-effect')).toContain('Anyone with the link');
    expect((r.byTestId('password-save') as HTMLButtonElement).disabled).toBe(true);
    await pick(r, 'who', 'password');
    (r.byTestId('password-save') as HTMLButtonElement).click();
    await r.settle();
    const req = r.http.expectOne({ method: 'PUT', url: `/v1/previews/${ID}/password` });
    expect(req.request.body).toEqual({ login: 'off', password: { mode: 'generate' } });
    req.flush({
      preview: {
        ...base,
        password: 'generated',
        passwordLogin: 'off',
        access: 'password',
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
    });
    await r.settle();
    await answerHistory(r);
    expect(r.text('password-badge')).toBe('Password');
    expect(r.text('password-effect')).toContain('including people signed in to gangway');
  });

  it('with a password of its own, switching to signed-in or either keeps it', async () => {
    const r = await open({
      permissions: member,
      preview: { ...base, password: 'set', passwordLogin: 'off', access: 'password' },
    });
    await answerHistory(r);
    await pick(r, 'who', 'either');
    expect((r.byTestId('password-source') as HTMLSelectElement).value).toBe('keep');
    (r.byTestId('password-save') as HTMLButtonElement).click();
    await r.settle();
    let req = r.http.expectOne({ method: 'PUT', url: `/v1/previews/${ID}/password` });
    expect(req.request.body).toEqual({ login: 'on' });
    req.flush({
      preview: {
        ...base,
        password: 'set',
        passwordLogin: 'on',
        access: 'either',
        updatedAt: '2026-09-23T00:00:01.000Z',
      },
    });
    await r.settle();
    await answerHistory(r);
    expect(r.text('password-badge')).toBe('Password or gangway login');
    expect(r.text('password-effect')).toContain('private window');

    await pick(r, 'who', 'signed-in');
    (r.byTestId('password-save') as HTMLButtonElement).click();
    await r.settle();
    req = r.http.expectOne({ method: 'PUT', url: `/v1/previews/${ID}/password` });
    expect(req.request.body).toEqual({ login: 'only' });
    req.flush({
      preview: {
        ...base,
        password: 'set',
        passwordLogin: 'only',
        access: 'signed-in',
        updatedAt: '2026-09-23T00:00:02.000Z',
      },
    });
    await r.settle();
    await answerHistory(r);
    expect(r.text('password-badge')).toBe('Gangway users');
  });

  it('without an update permission it only says who can open it', async () => {
    const r = await open({ preview: { ...base, password: 'set', access: 'password' } });
    await answerHistory(r);
    expect(r.text('password-effect')).toContain('Everyone is asked');
    expect(r.byTestId('who')).toBeNull();
  });
});
