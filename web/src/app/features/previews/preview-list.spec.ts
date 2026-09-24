import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { FakeEventSource } from '../../../testing/fake-event-source';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import contract from '../../../testing/fixtures/contract.json';
import { render, type Rendered } from '../../../testing/render';
import type { Permission, Preview, SessionInfo } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { EVENT_SOURCE_FACTORY, SSE_JITTER } from '../../core/sse.service';
import { Toasts } from '../../ui/toast';
import { PreviewList } from './preview-list';
import { displayName, primaryUrl, sourceLabel } from './source-label';

@Component({ template: '' })
class Blank {}

@Component({ imports: [PreviewList, Toasts], template: '<app-preview-list /><app-toasts />' })
class Host {}

const NOW = Date.parse('2026-09-21T20:00:00Z');
const p = (name: string, over: Partial<Preview> = {}): Preview => ({
  ...(contract.preview as Preview),
  id: `01${name.toUpperCase().padEnd(24, '0')}`,
  project: `gw-${name}`,
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  updatedAt: new Date(NOW - 3_600_000).toISOString(),
  ttlExpiresAt: new Date(NOW + 6 * 86_400_000).toISOString(),
  urls: [{ service: 'web', url: `https://${name}.preview.example.dev/`, primary: true }],
  ...over,
});
const ALL = [
  p('alpha'),
  p('bravo', {
    state: 'asleep',
    source: { kind: 'pr', repo: 'acme/shop', number: 42, sha: 'abc' },
  }),
  p('charlie', {
    state: 'starting',
    source: { kind: 'git', repo: 'https://github.com/acme/docs.git', ref: 'main' },
    ttlExpiresAt: null,
  }),
  p('delta', { state: 'failed', error: 'exit 1', source: { kind: 'tarball', uploadId: 'u1' } }),
];

async function open(
  o: { permissions?: Permission[]; query?: Record<string, string>; previews?: Preview[] } = {},
) {
  FakeEventSource.reset();
  const session: SessionInfo = {
    authenticated: true,
    setupRequired: false,
    user: { id: 'u', email: 'a@example.com', role: { id: 'member', name: 'member' } },
    permissions: o.permissions ?? ['previews.read', 'previews.destroy'],
  };
  const r = await render(Host, {
    routes: [
      { path: 'previews/:id', component: Blank },
      { path: '**', component: Blank },
    ],
    providers: [
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(o.query ?? {}) } },
      },
      { provide: EVENT_SOURCE_FACTORY, useValue: (url: string) => new FakeEventSource(url) },
      { provide: SSE_JITTER, useValue: () => 0 },
    ],
  });
  // The fixtures are dated around NOW, so relative times read against it.
  TestBed.inject(Clock).set(NOW);
  const auth = TestBed.inject(AuthService);
  const loading = auth.refresh();
  r.http.expectOne('/v1/auth/session').flush(session);
  await loading;
  r.http
    .expectOne((req) => req.url.startsWith('/v1/previews'))
    .flush({ seq: 5, previews: o.previews ?? ALL });
  await r.settle();
  FakeEventSource.last.open();
  await r.settle();
  return r;
}

const names = (r: Rendered<unknown>) => r.allByTestId('name').map((e) => e.textContent?.trim());
const click = async (r: Rendered<unknown>, id: string, within?: HTMLElement) => {
  ((within ?? r.el).querySelector(`[data-testid="${id}"]`) as HTMLElement).click();
  await r.settle();
};

describe('PreviewList', () => {
  beforeAll(installDialogPolyfill);

  it('lists previews newest first with name, host, state, source, expiry and age', async () => {
    const r = await open();
    expect(names(r)).toEqual(['delta', 'charlie', 'bravo', 'alpha']);
    const row = r.allByTestId('row')[1]!;
    expect(row.textContent).toContain('charlie.preview.example.dev');
    expect(row.textContent).toContain('starting');
    expect(row.textContent).toContain('acme/docs@main');
    expect(row.textContent).toContain('never');
    expect(r.allByTestId('row')[3]!.textContent).toContain('in 6 d');
    expect(r.text('connection')).toBe('live');
    expect(r.text('count')).toBe('4');
  });

  it('the name links to the detail page and the URL opens safely in a new tab', async () => {
    const r = await open();
    expect(r.allByTestId('name')[3]!.getAttribute('href')).toBe(`/previews/${ALL[0]!.id}`);
    const link = r.allByTestId('url')[3]!;
    expect(link.getAttribute('href')).toBe('https://alpha.preview.example.dev/');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('a row appears without a refresh when a deploy happens, and follows its states', async () => {
    const r = await open({ previews: [] });
    expect(r.text('empty')).toContain('No previews yet');
    expect(r.text('curl')).toContain('/v1/previews');

    const echo = p('echo', { state: 'building' });
    FakeEventSource.last.emit('preview.created', { previewId: echo.id, at: echo.createdAt }, '6');
    r.http.expectOne(`/v1/previews/${echo.id}`).flush({ preview: echo });
    await r.settle();
    expect(names(r)).toEqual(['echo']);
    expect(r.allByTestId('row')[0]!.textContent).toContain('building');

    FakeEventSource.last.emit(
      'preview.state',
      { previewId: echo.id, at: new Date(NOW).toISOString(), state: 'awake', from: 'starting' },
      '8',
    );
    await r.settle();
    expect(r.allByTestId('row')[0]!.textContent).toContain('awake');
  });

  describe('filters', () => {
    it('state chips, source and search combine, with building covering starting', async () => {
      const r = await open();
      await click(r, 'chip-building');
      expect(names(r)).toEqual(['charlie']);
      await click(r, 'chip-failed');
      expect(names(r)).toEqual(['delta', 'charlie']);
      expect(r.text('count')).toBe('2 of 4');

      const source = r.byTestId('source') as HTMLSelectElement;
      source.value = 'tarball';
      source.dispatchEvent(new Event('change'));
      await r.settle();
      expect(names(r)).toEqual(['delta']);

      await click(r, 'chip-building');
      await click(r, 'chip-failed');
      source.value = '';
      source.dispatchEvent(new Event('change'));
      const search = r.byTestId('search') as HTMLInputElement;
      search.value = 'ACME/shop';
      search.dispatchEvent(new Event('input'));
      await r.settle();
      expect(names(r)).toEqual(['bravo']);
    });

    it('are written to the URL, so a filtered view survives a reload', async () => {
      const r = await open();
      const router = TestBed.inject(Router);
      const navigate = vi.spyOn(router, 'navigate');
      await click(r, 'chip-awake');
      expect(navigate).toHaveBeenLastCalledWith(
        [],
        expect.objectContaining({
          replaceUrl: true,
          queryParams: { state: 'awake', source: null, q: null, destroyed: null },
        }),
      );
    });

    it('are read back from the URL, ignoring anything that is not a real filter', async () => {
      const r = await open({ query: { state: 'asleep,banana', source: 'pr', q: 'shop' } });
      expect(names(r)).toEqual(['bravo']);
      expect(r.byTestId('chip-asleep')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('nothing matching is not the same as nothing existing', async () => {
      const r = await open({ query: { q: 'zzz' } });
      expect(r.text('empty')).toContain('Nothing matches');
      await click(r, 'clear');
      expect(names(r)).toHaveLength(4);
    });

    it('"destroyed" refetches with includeDestroyed', async () => {
      const r = await open();
      const box = r.byTestId('show-destroyed') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      r.http
        .expectOne('/v1/previews?includeDestroyed=true')
        .flush({ seq: 9, previews: [...ALL, p('gone', { state: 'destroyed' })] });
      await r.settle();
      expect(names(r)).toContain('gone');
      const gone = r.allByTestId('row').find((row) => row.textContent?.includes('gone'))!;
      expect(gone.querySelector('[data-testid="expires"]')!.textContent?.trim()).toBe('—');
    });
  });

  describe('destroy', () => {
    it('is not offered to a role without previews.destroy', async () => {
      const r = await open({ permissions: ['previews.read'] });
      expect(r.allByTestId('destroy')).toHaveLength(0);
    });

    it('asks first with focus on Cancel, and cancelling asks the server nothing', async () => {
      const r = await open();
      await click(r, 'destroy', r.allByTestId('row')[3]!);
      expect(r.byTestId('confirm')!.hasAttribute('open')).toBe(true);
      expect(r.byTestId('confirm')!.textContent).toContain('Destroy alpha?');
      expect(document.activeElement).toBe(r.byTestId('confirm-cancel'));
      await click(r, 'confirm-cancel');
      r.http.expectNone(`/v1/previews/${ALL[0]!.id}`);
      expect(r.allByTestId('row')[3]!.textContent).toContain('awake');
    });

    it('once confirmed the row says destroying at once and offers no second Destroy', async () => {
      const r = await open();
      await click(r, 'destroy', r.allByTestId('row')[3]!);
      await click(r, 'confirm-ok');
      const row = r.allByTestId('row')[3]!;
      expect(row.textContent).toContain('destroying');
      expect(row.querySelector('[data-testid="destroy"]')).toBeNull();
      r.http
        .expectOne({ method: 'DELETE', url: `/v1/previews/${ALL[0]!.id}` })
        .flush({ preview: { ...ALL[0]!, state: 'destroyed' } });
      await r.settle();
      expect(r.allByTestId('row')[3]!.textContent).toContain('destroyed');
    });

    it('a refusal rolls back, toasts the request id, and asks for permissions again', async () => {
      const r = await open();
      await click(r, 'destroy', r.allByTestId('row')[3]!);
      await click(r, 'confirm-ok');
      r.http.expectOne(`/v1/previews/${ALL[0]!.id}`).flush(
        {
          title: 'forbidden',
          detail: 'requires the "previews.destroy" permission',
          requestId: '01REQ',
        },
        { status: 403, statusText: 'x' },
      );
      await r.until(() => r.byTestId('toast') !== null, 'the error toast');
      expect(r.allByTestId('row')[3]!.textContent).toContain('awake');
      expect(r.text('toast')).toContain('Could not destroy alpha');
      expect(r.text('toast')).toContain('request 01REQ');

      r.http
        .expectOne('/v1/auth/session')
        .flush({ authenticated: true, setupRequired: false, permissions: ['previews.read'] });
      await r.settle();
      expect(r.allByTestId('destroy')).toHaveLength(0);
    });
  });

  it('a failed load shows the request id rather than an empty list', async () => {
    FakeEventSource.reset();
    const r = await render(PreviewList, {
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: EVENT_SOURCE_FACTORY, useValue: (u: string) => new FakeEventSource(u) },
      ],
    });
    r.http
      .expectOne('/v1/previews')
      .flush(
        { title: 'internal', detail: 'internal error', requestId: '01REQ' },
        { status: 500, statusText: 'x' },
      );
    await r.until(() => r.byTestId('list-error') !== null, 'the load error');
    expect(r.text('list-error')).toContain('01REQ');
    expect(r.byTestId('empty')).toBeNull();
  });
});

describe('source labels', () => {
  it.each([
    [{ kind: 'pr', repo: 'acme/shop', number: 42, sha: 'x' }, 'acme/shop#42'],
    [{ kind: 'git', repo: 'https://github.com/acme/docs.git', ref: 'main' }, 'acme/docs@main'],
    [
      { kind: 'git', repo: 'https://gitlab.example/acme/docs', ref: 'v2' },
      'https://gitlab.example/acme/docs@v2',
    ],
    [{ kind: 'image', image: 'traefik/whoami:v1.10' }, 'traefik/whoami:v1.10'],
    [{ kind: 'tarball', uploadId: 'u' }, 'uploaded archive'],
    [
      { kind: 'tarball', uploadId: 'u', runtime: 'static', serve: 'gangway' },
      'uploaded files · static · served by gangway',
    ],
  ] as const)('%o -> %s', (source, want) => expect(sourceLabel(source)).toBe(want));

  it('names by title, else the slug without gw-; prefers the primary URL', () => {
    expect(displayName({ project: 'gw-hello', title: null })).toBe('hello');
    expect(displayName({ project: 'gw-hello', title: 'Hello, world' })).toBe('Hello, world');
    expect(
      primaryUrl({
        urls: [
          { service: 'api', url: 'https://a/', primary: false },
          { service: 'web', url: 'https://w/', primary: true },
        ],
      }),
    ).toBe('https://w/');
    expect(primaryUrl({ urls: [] })).toBeNull();
  });

  it('offers New preview only to a role with previews.deploy', async () => {
    const without = await open({ previews: [] });
    expect(without.byTestId('new')).toBeNull();
    expect(without.byTestId('empty-new')).toBeNull();
    TestBed.resetTestingModule();
    const withIt = await open({ permissions: ['previews.read', 'previews.deploy'], previews: [] });
    expect(withIt.byTestId('new')?.getAttribute('href')).toBe('/new');
    expect(withIt.byTestId('empty-new')?.getAttribute('href')).toBe('/new');
  });
});

describe('PreviewList: passwords', () => {
  it('marks protected rows with who can open them', async () => {
    const r = await open({
      previews: [
        p('open'),
        p('locked', { password: 'set', access: 'password' }),
        p('mine', { password: 'generated', access: 'either' }),
        p('team', { passwordLogin: 'only', access: 'signed-in' }),
      ],
    });
    const badge = (id: string) =>
      r.fixture.nativeElement
        .querySelector(`[data-id="${id}"] [data-testid="password-badge"]`)
        ?.textContent?.trim() ?? null;
    expect(badge(p('open').id)).toBeNull();
    expect(badge(p('locked').id)).toBe('Password');
    expect(badge(p('mine').id)).toBe('Password or gangway login');
    expect(badge(p('team').id)).toBe('Gangway users');
  });
});
