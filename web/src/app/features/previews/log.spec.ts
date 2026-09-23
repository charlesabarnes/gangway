import { TestBed } from '@angular/core/testing';
import { FakeEventSource } from '../../../testing/fake-event-source';
import { render, type Rendered } from '../../../testing/render';
import type { LogLine, LogStream } from '../../core/api.types';
import { EVENT_SOURCE_FACTORY, SSE_JITTER } from '../../core/sse.service';
import { LogBuffer, isStuckToBottom, stripAnsi } from './log-buffer';
import { FRAME, LogViewer } from './log-viewer';

const line = (n: number, text = `line ${n}`, stream: LogStream = 'stdout'): LogLine => ({
  n,
  at: '2026-09-21T20:00:00.000Z',
  stream,
  line: text,
});

describe('stripAnsi', () => {
  it.each([
    ['\x1b[32mgreen\x1b[0m', 'green'],
    ['\x1b[1;31;40mbold red on black\x1b[m', 'bold red on black'],
    ['\x1b[2K\x1b[1Gprogress 50%', 'progress 50%'], // erase line + cursor to column 1
    ['\x1b[?25lhidden cursor\x1b[?25h', 'hidden cursor'],
    ['bell\x07 and backspace\x08', 'bell and backspace'],
    ['tabs\tand newlines stay', 'tabs\tand newlines stay'],
    ['no escapes [32m here', 'no escapes [32m here'], // a literal bracket is not an escape
  ])('%j -> %j', (raw, want) => expect(stripAnsi(raw)).toBe(want));
});

describe('isStuckToBottom', () => {
  it('a sub-pixel gap still counts as the bottom; scrolling up a line or two does not', () => {
    expect(isStuckToBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isStuckToBottom({ scrollHeight: 1000, scrollTop: 599.5, clientHeight: 400 })).toBe(true);
    expect(isStuckToBottom({ scrollHeight: 1000, scrollTop: 577, clientHeight: 400 })).toBe(true);
    expect(isStuckToBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(false);
  });
});

describe('LogBuffer', () => {
  it('keeps the LAST N lines and counts what it let go', () => {
    const b = new LogBuffer(3);
    b.push([line(1), line(2)]);
    b.push([line(3), line(4), line(5)]);
    expect(b.lines.map((l) => l.n)).toEqual([3, 4, 5]);
    expect(b.dropped).toBe(2);
  });

  it('a reconnect replays an overlap: anything not NEWER than the last line held is ignored', () => {
    const b = new LogBuffer();
    b.push([line(1), line(2), line(3)]);
    expect(b.push([line(2), line(3)])).toBe(false);
    expect(b.push([line(3), line(4)])).toBe(true);
    expect(b.lines.map((l) => l.n)).toEqual([1, 2, 3, 4]);
  });

  it('strips escapes on the way in, once, not on every render', () => {
    const b = new LogBuffer();
    b.push([line(1, '\x1b[32m#5 DONE 0.4s\x1b[0m', 'build')]);
    expect(b.lines[0]!.line).toBe('#5 DONE 0.4s');
  });

  it('one huge batch is bounded too', () => {
    const b = new LogBuffer(100);
    b.push(Array.from({ length: 10_000 }, (_, i) => line(i + 1)));
    expect(b.lines).toHaveLength(100);
    expect(b.lines[0]!.n).toBe(9_901);
    expect(b.dropped).toBe(9_900);
  });
});

describe('LogViewer', () => {
  /** Frame, by hand: nothing reaches the screen until the spec says a frame happened. */
  let frames: (() => void)[] = [];
  const nextFrame = () => {
    const run = frames;
    frames = [];
    for (const f of run) f();
  };

  const open = async (inputs: Record<string, unknown> = { previewId: '01ABC' }) => {
    FakeEventSource.reset();
    frames = [];
    const r = await render(LogViewer, {
      inputs,
      providers: [
        { provide: EVENT_SOURCE_FACTORY, useValue: (url: string) => new FakeEventSource(url) },
        { provide: SSE_JITTER, useValue: () => 0 },
        { provide: FRAME, useValue: (cb: () => void) => frames.push(cb) },
      ],
    });
    return r;
  };
  const emit = (n: number, text = `line ${n}`, stream: LogStream = 'stdout') =>
    FakeEventSource.last.emit(
      'log',
      { at: '2026-09-21T20:00:00.000Z', stream, line: text },
      String(n),
    );
  /** `<n> <text>`: two spans whose gap is CSS, so they are read separately. */
  const shown = (r: Rendered<unknown>) =>
    r.allByTestId('line').map((e) =>
      Array.from(e.querySelectorAll('span'))
        .map((s) => s.textContent ?? '')
        .join(' '),
    );

  it('asks for a TAIL, not the whole log, and listens for the named `log` event', async () => {
    await open();
    expect(FakeEventSource.last.url).toBe('/v1/previews/01ABC/logs?tail=2000');
    expect(FakeEventSource.last.listensTo('log')).toBe(true);
  });

  it('a burst of lines is ONE render, on the next frame -- not one per line', async () => {
    const r = await open();
    FakeEventSource.last.open();
    nextFrame(); // the initial scroll-to-bottom
    for (let n = 1; n <= 500; n++) emit(n);
    await r.settle();
    expect(shown(r)).toHaveLength(0); // nothing yet: no frame has happened
    expect(frames).toHaveLength(1); // and 500 lines scheduled exactly one

    nextFrame();
    await r.settle();
    expect(shown(r)).toHaveLength(500);
    expect(shown(r)[0]).toBe('1 line 1');
  });

  it('"build log" is a filter over one stream, not a second request', async () => {
    const r = await open();
    FakeEventSource.last.open();
    emit(1, 'deploying gw-x', 'system');
    emit(2, '#1 [internal] load build definition', 'build');
    emit(3, '#2 DONE', 'build');
    emit(4, 'listening on :80', 'stdout');
    emit(5, 'warn: x', 'stderr');
    nextFrame();
    await r.settle();
    expect(shown(r)).toHaveLength(5);

    (r.byTestId('stream-build') as HTMLElement).click();
    await r.settle();
    expect(shown(r)).toEqual(['2 #1 [internal] load build definition', '3 #2 DONE']);
    expect(FakeEventSource.instances).toHaveLength(1);

    (r.byTestId('stream-stderr') as HTMLElement).click();
    await r.settle();
    expect(shown(r)).toEqual(['5 warn: x']);
  });

  it('shows the server\'s "earlier lines not shown" line like any other', async () => {
    const r = await open();
    FakeEventSource.last.open();
    emit(4000, '... 4000 earlier lines not shown', 'system');
    emit(4001);
    nextFrame();
    await r.settle();
    expect(shown(r)[0]).toBe('4000 ... 4000 earlier lines not shown');
  });

  it('escape codes never reach the DOM', async () => {
    const r = await open();
    FakeEventSource.last.open();
    emit(1, '\x1b[32m✔ built\x1b[0m', 'build');
    nextFrame();
    await r.settle();
    expect(r.byTestId('log')!.textContent).not.toContain('\x1b');
    expect(shown(r)).toEqual(['1 ✔ built']);
  });

  describe('scrolling', () => {
    const measure = (el: HTMLElement, m: { scrollHeight: number; clientHeight: number }) => {
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => m.scrollHeight });
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => m.clientHeight });
    };

    it('follows the bottom while you are AT the bottom', async () => {
      const r = await open();
      const log = r.byTestId('log')!;
      measure(log, { scrollHeight: 5000, clientHeight: 400 });
      FakeEventSource.last.open();
      emit(1);
      nextFrame();
      await r.settle();
      nextFrame();
      expect(log.scrollTop).toBe(5000);
      expect(r.byTestId('jump')).toBeNull();
    });

    it('scrolling up to read something is NOT yanked back down by the next line; a pill offers the way back', async () => {
      const r = await open();
      const log = r.byTestId('log')!;
      measure(log, { scrollHeight: 5000, clientHeight: 400 });
      FakeEventSource.last.open();
      emit(1);
      nextFrame();
      await r.settle();
      nextFrame();

      log.scrollTop = 1200;
      log.dispatchEvent(new Event('scroll'));
      await r.settle();
      expect(r.byTestId('jump')).not.toBeNull();
      emit(2);
      nextFrame();
      await r.settle();
      nextFrame();
      expect(log.scrollTop).toBe(1200);

      (r.byTestId('jump') as HTMLElement).click();
      await r.settle();
      expect(log.scrollTop).toBe(5000);
      expect(r.byTestId('jump')).toBeNull();
    });
  });

  it('follow=false opens no stream at all: a destroyed preview has no log left to follow', async () => {
    await open({ previewId: '01ABC', follow: false });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('closes its stream when it goes away, and reopens for a different preview', async () => {
    const r = await open();
    const first = FakeEventSource.last;
    r.fixture.componentRef.setInput('previewId', '01XYZ');
    await r.settle();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.last.url).toBe('/v1/previews/01XYZ/logs?tail=2000');
    r.fixture.destroy();
    expect(FakeEventSource.last.closed).toBe(true);
    void TestBed;
  });

  it('is a labelled, focusable log region, so it can be reached and scrolled by keyboard', async () => {
    const r = await open();
    const log = r.byTestId('log')!;
    expect(log.getAttribute('role')).toBe('log');
    expect(log.getAttribute('tabindex')).toBe('0');
    expect(log.getAttribute('aria-label')).toBe('Preview log');
  });
});
