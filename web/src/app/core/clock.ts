import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/**
 * "now", as a signal. Zoneless Angular redraws when a signal changes and at no other time,
 * so "expires in 3 h" would sit frozen forever unless something ticks. One interval for the
 * whole app, coarse on purpose: relative times do not need second precision.
 */
@Injectable({ providedIn: 'root' })
export class Clock {
  readonly #now = signal(Date.now());
  readonly now = this.#now.asReadonly();

  constructor() {
    const t = setInterval(() => this.#now.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  /** For specs. */
  set(ms: number): void {
    this.#now.set(ms);
  }
}
