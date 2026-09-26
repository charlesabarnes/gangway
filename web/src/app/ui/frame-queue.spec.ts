import { FrameQueue } from './frame-queue';

describe('FrameQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets three frames load at once and starts the next as one finishes', async () => {
    const q = new FrameQueue();
    const releases: (() => void)[] = [];
    const started: number[] = [];
    for (let i = 0; i < 5; i++) void q.acquire().then((r) => (started.push(i), releases.push(r)));
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    releases[0]!();
    releases[0]!();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(q.running).toBe(3);
  });

  it('frees a slot nobody released after its timeout', async () => {
    const q = new FrameQueue();
    for (let i = 0; i < 3; i++) void q.acquire();
    let fourth = false;
    void q.acquire().then(() => (fourth = true));
    await Promise.resolve();
    expect(fourth).toBe(false);
    vi.advanceTimersByTime(q.timeoutMs);
    await Promise.resolve();
    expect(fourth).toBe(true);
  });
});
