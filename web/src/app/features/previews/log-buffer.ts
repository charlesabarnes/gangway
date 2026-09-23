import type { LogLine } from '../../core/api.types';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, '').replace(CONTROL, '');

export const STICK_THRESHOLD_PX = 24;
export const isStuckToBottom = (m: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean => m.scrollHeight - m.scrollTop - m.clientHeight < STICK_THRESHOLD_PX;

export class LogBuffer {
  readonly #max: number;
  #lines: LogLine[] = [];
  #last = 0;
  #dropped = 0;

  constructor(max = 5_000) {
    this.#max = max;
  }

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
  get dropped(): number {
    return this.#dropped;
  }
  get lastN(): number {
    return this.#last;
  }
}
