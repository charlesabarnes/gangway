import type { LogLine } from '../../core/api.types';

/** CSI sequences: colours, cursor movement, erase-line. Build tools emit all three. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** What is left of a progress bar once the escapes are gone. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** No ANSI library: colour in a build log is decoration, and rendering it means trusting it. */
export const stripAnsi = (s: string): string => s.replace(ANSI, '').replace(CONTROL, '');

/** Closer than this to the bottom counts as "at the bottom": a sub-pixel gap must not unstick the view. */
export const STICK_THRESHOLD_PX = 24;
export const isStuckToBottom = (m: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean => m.scrollHeight - m.scrollTop - m.clientHeight < STICK_THRESHOLD_PX;

/**
 * The last N lines. A build can emit tens of thousands; a tab that kept them all would
 * grow without limit, and nobody scrolls back that far in a browser -- the server has the
 * whole log.
 *
 * Lines carry the server's line number `n`. Anything not NEWER than the last line held is
 * dropped: a reconnect replays from the last id the browser acknowledged, which can
 * overlap what already arrived.
 */
export class LogBuffer {
  readonly #max: number;
  #lines: LogLine[] = [];
  #last = 0;
  #dropped = 0;

  constructor(max = 5_000) {
    this.#max = max;
  }

  /** True if anything was added. */
  push(batch: readonly LogLine[]): boolean {
    const fresh = batch
      .filter((l) => l.n > this.#last)
      .map((l) => ({ ...l, line: stripAnsi(l.line) }));
    if (fresh.length === 0) return false;
    this.#last = fresh[fresh.length - 1]!.n;
    const all = this.#lines.concat(fresh);
    const over = all.length - this.#max;
    if (over > 0) this.#dropped += over;
    this.#lines = over > 0 ? all.slice(over) : all;
    return true;
  }

  get lines(): readonly LogLine[] {
    return this.#lines;
  }
  /** Lines this tab let go of to stay bounded. */
  get dropped(): number {
    return this.#dropped;
  }
  get lastN(): number {
    return this.#last;
  }
}
