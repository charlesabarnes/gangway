import { Injectable } from '@angular/core';

/** Lets a few frames load at a time, so a page of thumbnails does not start them all at once. */
@Injectable({ providedIn: 'root' })
export class FrameQueue {
  readonly limit: number = 3;
  readonly timeoutMs: number = 8000;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  get running(): number {
    return this.#running;
  }

  /** Resolves with a release function once a slot is free; a slot left unreleased frees itself. */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const start = () => {
        this.#running++;
        let done = false;
        const release = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.#running--;
          this.#waiting.shift()?.();
        };
        const timer = setTimeout(release, this.timeoutMs);
        resolve(release);
      };
      if (this.#running < this.limit) start();
      else this.#waiting.push(start);
    });
  }
}
