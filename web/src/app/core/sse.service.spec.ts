import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { FakeEventSource } from '../../testing/fake-event-source';
import { AuthService } from './auth.service';
import { EVENT_SOURCE_FACTORY, SSE_JITTER, SseService, type SseMessage } from './sse.service';

@Component({ template: '' })
class Blank {}

function setup() {
  FakeEventSource.reset();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'login', component: Blank },
        { path: 'previews/:id', component: Blank },
      ]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: EVENT_SOURCE_FACTORY, useValue: (url: string) => new FakeEventSource(url) },
      { provide: SSE_JITTER, useValue: () => 0 },
    ],
  });
  const got: SseMessage<{ n: number }>[] = [];
  const open = (url = '/v1/events') =>
    TestBed.inject(SseService).open<{ n: number }>(url, ['preview.state', 'reset'], (m) =>
      got.push(m),
    );
  return { got, open, http: TestBed.inject(HttpTestingController) };
}

const hide = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('SseService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    hide('visible');
    vi.useRealTimers();
  });

  it('delivers named events, parsed, with their ids', () => {
    const t = setup();
    const h = t.open();
    expect(h.status()).toBe('connecting');
    FakeEventSource.last.open();
    expect(h.status()).toBe('live');
    expect(FakeEventSource.last.listensTo('preview.state')).toBe(true);
    FakeEventSource.last.emit('preview.state', { n: 1 }, '41');
    FakeEventSource.last.emit('reset', { n: 2 }, '42');
    expect(t.got).toEqual([
      { type: 'preview.state', data: { n: 1 }, id: '41' },
      { type: 'reset', data: { n: 2 }, id: '42' },
    ]);
  });

  it('drops a malformed frame and carries on', () => {
    const t = setup();
    t.open();
    FakeEventSource.last.open();
    FakeEventSource.last.emit('preview.state', '{not json', '1');
    FakeEventSource.last.emit('preview.state', { n: 2 }, '2');
    expect(t.got.map((m) => m.data)).toEqual([{ n: 2 }]);
  });

  it('on any error it closes the source and reopens from the last id itself', async () => {
    const t = setup();
    const h = t.open();
    const first = FakeEventSource.last;
    first.open();
    first.emit('preview.state', { n: 1 }, '41');
    first.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.closed).toBe(true);
    expect(h.status()).toBe('reconnecting');
    expect(FakeEventSource.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last.url).toBe('/v1/events?after=41');
    FakeEventSource.last.open();
    expect(h.status()).toBe('live');
  });

  it('appends `after` with & when the URL already has a query', async () => {
    const t = setup();
    t.open('/v1/previews/x/logs?tail=2000');
    FakeEventSource.last.open();
    FakeEventSource.last.emit('preview.state', { n: 1 }, '977');
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.last.url).toBe('/v1/previews/x/logs?tail=2000&after=977');
  });

  it('starts from a given cursor, and a reconnect replaces it rather than adding one', async () => {
    setup();
    TestBed.inject(SseService).open('/v1/events', ['preview.state'], () => {}, { after: 3 });
    expect(FakeEventSource.last.url).toBe('/v1/events?after=3');
    FakeEventSource.last.open();
    FakeEventSource.last.emit('preview.state', { n: 1 }, '9');
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.last.url).toBe('/v1/events?after=9');
  });

  it('backs off 1, 2, 5, 10, 15, 15 seconds; a successful open resets it', async () => {
    const t = setup();
    t.open();
    for (const expected of [1000, 2000, 5000, 10_000, 15_000, 15_000]) {
      const before = FakeEventSource.instances.length;
      FakeEventSource.last.fail();
      await vi.advanceTimersByTimeAsync(0);
      t.http
        .match('/v1/auth/session')
        .forEach((r) => r.flush({ authenticated: true, setupRequired: false, permissions: [] }));
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(FakeEventSource.instances.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.instances.length).toBe(before + 1);
    }

    FakeEventSource.last.open();
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.instances).toHaveLength(8);
  });

  it('after two failures it asks who we are, and goes to login if signed out', async () => {
    const t = setup();
    await TestBed.inject(Router).navigateByUrl('/previews/01ABC');
    const h = t.open();
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(0);
    t.http.expectNone('/v1/auth/session');
    await vi.advanceTimersByTimeAsync(1000);

    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(0);
    t.http.expectOne('/v1/auth/session').flush({ authenticated: false, setupRequired: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.status()).toBe('closed');
    expect(TestBed.inject(AuthService).authenticated()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(TestBed.inject(Router).url).toBe('/login?returnUrl=%2Fpreviews%2F01ABC');
  });

  it('keeps trying, without logging out, when the server is down', async () => {
    const t = setup();
    const h = t.open();
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(1000);
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(0);
    t.http.expectOne('/v1/auth/session').error(new ProgressEvent('error'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.status()).toBe('reconnecting');
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('close() stops reopening and ignores a late event from the old source', async () => {
    const t = setup();
    const h = t.open();
    const source = FakeEventSource.last;
    source.open();
    source.fail();
    h.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(h.status()).toBe('closed');
    source.emit('preview.state', { n: 9 }, '9');
    expect(t.got).toEqual([]);
  });

  it('a tab hidden for 30 s drops its connection and resumes from where it left off', async () => {
    const t = setup();
    const h = t.open();
    FakeEventSource.last.open();
    FakeEventSource.last.emit('preview.state', { n: 1 }, '7');

    hide('hidden');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.status()).toBe('live');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.status()).toBe('paused');
    expect(FakeEventSource.last.closed).toBe(true);

    hide('visible');
    expect(h.status()).toBe('connecting');
    expect(FakeEventSource.last.url).toBe('/v1/events?after=7');
  });

  it('coming back within the grace period changes nothing', async () => {
    const t = setup();
    const h = t.open();
    FakeEventSource.last.open();
    hide('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    hide('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.status()).toBe('live');
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
