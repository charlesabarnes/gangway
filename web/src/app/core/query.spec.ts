import { TestBed } from '@angular/core/testing';
import { QueryCache } from './query';

describe('QueryCache', () => {
  it('shows the last answer at once on the next visit, and refreshes behind it', async () => {
    const cache = TestBed.inject(QueryCache);
    let n = 0;
    const load = () => Promise.resolve(++n);
    const first = cache.query('k', load);
    expect(first.loaded()).toBe(false);
    await first.refresh();
    expect(first.data()).toBe(1);

    const again = cache.query('k', load);
    expect(again.data()).toBe(1);
    await again.refresh();
    expect(again.data()).toBeGreaterThan(1);
  });

  it('shares one request, keeps data through a failure, forgets on invalidate', async () => {
    const cache = TestBed.inject(QueryCache);
    let calls = 0;
    let fail = false;
    const load = () => {
      calls++;
      return fail ? Promise.reject(new Error('down')) : Promise.resolve('ok');
    };
    const q = cache.query('k', load);
    cache.query('k', load);
    await q.refresh();
    expect(calls).toBe(1);
    fail = true;
    await q.refresh();
    expect(q.data()).toBe('ok');
    expect(q.error()?.detail).toBe('down');
    cache.invalidate('k');
    expect(cache.query('k', () => Promise.resolve('new')).data()).toBeUndefined();
  });
});
