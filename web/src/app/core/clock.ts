import { DestroyRef, Injectable, inject, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class Clock {
  readonly #now = signal(Date.now());
  readonly now = this.#now.asReadonly();

  constructor() {
    const t = setInterval(() => this.#now.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  set(ms: number): void {
    this.#now.set(ms);
  }
}
