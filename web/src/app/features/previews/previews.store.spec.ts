import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeEventSource } from '../../../testing/fake-event-source';
import contract from '../../../testing/fixtures/contract.json';
import type { Preview } from '../../core/api.types';
import { EVENT_SOURCE_FACTORY, SSE_JITTER } from '../../core/sse.service';
import { DESTROYED_LINGER_MS, PreviewsStore } from './previews.store';

const T0 = '2026-09-21T20:00:00.000Z';
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const preview = (id: string, over: Partial<Preview> = {}): Preview => ({ ...(contract.preview as Preview), id, project: `gw-${id}`, updatedAt: T0, ...over });

function setup() {
  FakeEventSource.reset();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: EVENT_SOURCE_FACTORY, useValue: (url: string) => new FakeEventSource(url) },
      { provide: SSE_JITTER, useValue: () => 0 },
    ],
  });
  const store = TestBed.inject(PreviewsStore);
  const http = TestBed.inject(HttpTestingController);
  const tick = () => vi.advanceTimersByTimeAsync(0);
  /** connect(), answer the list, and open the stream. */
  const start = async (previews: Preview[], seq = 7) => {
    store.connect();
    http.expectOne('/v1/previews').flush({ seq, previews });
    await tick();
    FakeEventSource.last.open();
    return FakeEventSource.last;
  };
  const ids = () => store.previews().map((p) => `${p.id}:${p.state}`);
  return { store, http, tick, start, ids };
}

describe('PreviewsStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fetches, then follows /v1/events FROM THE CURSOR THE LIST CAME WITH -- not from 0, not from "now"', async () => {
    const t = setup();
    const source = await t.start([preview('01A'), preview('01B')], 42);
    expect(source.url).toBe('/v1/events?after=42');
    expect(t.ids()).toEqual(['01B:awake', '01A:awake']); // newest first
    expect(t.store.status()).toBe('live');
  });

  it('a state event patches the row in place', async () => {
    const t = setup();
    const source = await t.start([preview('01A')]);
    source.emit('preview.state', { previewId: '01A', at: at(5), state: 'failed', from: 'awake', error: 'it fell over' }, '8');
    expect(t.store.previews()[0]).toMatchObject({ state: 'failed', error: 'it fell over', updatedAt: at(5) });
  });

  it('an event OLDER than the row is ignored: a reconnect replays history onto a list that is already newer', async () => {
    const t = setup();
    const source = await t.start([preview('01A', { state: 'awake', updatedAt: at(60) })]);
    source.emit('preview.state', { previewId: '01A', at: at(10), state: 'starting', from: 'building' }, '8');
    expect(t.ids()).toEqual(['01A:awake']);
  });

  it('created and adopted carry no preview, so it is fetched -- ONCE, however many events name it at once', async () => {
    const t = setup();
    const source = await t.start([]);
    source.emit('preview.created', { previewId: '01NEW', at: at(1) }, '8');
    source.emit('preview.state', { previewId: '01NEW', at: at(1), state: 'starting', from: 'building' }, '9');
    source.emit('preview.state', { previewId: '01NEW', at: at(2), state: 'awake', from: 'starting' }, '10');
    t.http.expectOne('/v1/previews/01NEW').flush({ preview: preview('01NEW', { state: 'awake', updatedAt: at(2) }) });
    await t.tick();
    expect(t.ids()).toEqual(['01NEW:awake']);
    t.http.verify();
  });

  it('`reset` means drop everything, refetch, and follow from the NEW cursor', async () => {
    const t = setup();
    const source = await t.start([preview('01A')], 7);
    source.emit('reset', { at: at(1), reason: 'backlog' }, '');
    t.http.expectOne('/v1/previews').flush({ seq: 5000, previews: [preview('01Z')] });
    await t.tick();
    expect(t.ids()).toEqual(['01Z:awake']);
    expect(source.closed).toBe(true);
    expect(FakeEventSource.last.url).toBe('/v1/events?after=5000');
  });

  it('a preview destroyed while you watch lingers, greyed, then goes', async () => {
    const t = setup();
    const source = await t.start([preview('01A'), preview('01B')]);
    source.emit('preview.state', { previewId: '01A', at: at(5), state: 'destroyed', from: 'destroying' }, '8');
    expect(t.ids()).toEqual(['01B:awake', '01A:destroyed']);
    expect(t.store.previews()[1]!.destroyedAt).toBe(at(5));
    await vi.advanceTimersByTimeAsync(DESTROYED_LINGER_MS - 1);
    expect(t.ids()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.ids()).toEqual(['01B:awake']);
  });

  it('...unless destroyed previews were asked for, which refetches with includeDestroyed and keeps them', async () => {
    const t = setup();
    await t.start([preview('01A')]);
    const on = t.store.setIncludeDestroyed(true);
    t.http.expectOne('/v1/previews?includeDestroyed=true').flush({ seq: 9, previews: [preview('01A'), preview('010', { state: 'destroyed' })] });
    await on;
    await vi.advanceTimersByTimeAsync(DESTROYED_LINGER_MS * 2);
    expect(t.ids()).toEqual(['01A:awake', '010:destroyed']);
  });

  it('two screens share one fetch and one stream; the stream closes when the LAST one leaves', async () => {
    const t = setup();
    const source = await t.start([preview('01A')]);
    t.store.connect(); // the detail page, while the list is still up
    t.http.expectNone('/v1/previews');
    expect(FakeEventSource.instances).toHaveLength(1);
    t.store.disconnect();
    expect(source.closed).toBe(false);
    t.store.disconnect();
    expect(source.closed).toBe(true);
    expect(t.store.status()).toBe('idle');
  });

  it('load(id) brings one preview in for a deep link, and is undefined -- not a throw -- when it does not exist', async () => {
    const t = setup();
    const hit = t.store.load('01A');
    t.http.expectOne('/v1/previews/01A').flush({ preview: preview('01A') });
    expect((await hit)?.id).toBe('01A');
    expect(t.store.byId('01A')()?.project).toBe('gw-01A');

    const miss = t.store.load('nope');
    t.http.expectOne('/v1/previews/nope').flush({ title: 'not found' }, { status: 404, statusText: 'x' });
    expect(await miss).toBeUndefined();
  });

  it('a failed list keeps what was on screen and says why', async () => {
    const t = setup();
    await t.start([preview('01A')]);
    const again = t.store.reload();
    t.http.expectOne('/v1/previews').flush({ title: 'internal', detail: 'internal error', requestId: '01REQ' }, { status: 500, statusText: 'x' });
    await again;
    expect(t.store.error()).toMatchObject({ status: 500, requestId: '01REQ' });
    expect(t.ids()).toEqual(['01A:awake']);
  });

  describe('destroy', () => {
    it('is optimistic: `destroying` at once, then whatever the server says', async () => {
      const t = setup();
      await t.start([preview('01A')]);
      const done = t.store.destroy('01A');
      expect(t.ids()).toEqual(['01A:destroying']);
      t.http.expectOne({ method: 'DELETE', url: '/v1/previews/01A' }).flush({ preview: preview('01A', { state: 'destroyed', destroyedAt: at(3) }) });
      await done;
      expect(t.ids()).toEqual(['01A:destroyed']);
    });

    it('rolls back when the server refuses, and rejects with something showable', async () => {
      const t = setup();
      await t.start([preview('01A')]);
      const done = t.store.destroy('01A');
      t.http.expectOne('/v1/previews/01A').flush({ title: 'forbidden', detail: 'requires the "previews.destroy" permission', requestId: '01REQ' }, { status: 403, statusText: 'x' });
      await expect(done).rejects.toMatchObject({ status: 403, requestId: '01REQ', detail: 'requires the "previews.destroy" permission' });
      expect(t.ids()).toEqual(['01A:awake']);
    });

    it('does NOT roll back over news that arrived meanwhile', async () => {
      const t = setup();
      const source = await t.start([preview('01A')]);
      const done = t.store.destroy('01A');
      source.emit('preview.state', { previewId: '01A', at: at(9), state: 'failed', from: 'awake' }, '8');
      t.http.expectOne('/v1/previews/01A').flush({ title: 'conflict' }, { status: 409, statusText: 'x' });
      await done.catch(() => {});
      expect(t.ids()).toEqual(['01A:failed']);
    });
  });
});
