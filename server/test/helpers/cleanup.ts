// setup.ts runs these after every test: a helper's own afterEach registers in the first importing file only.
const pending: (() => void | Promise<void>)[] = [];

/** Runs after the current test, newest first, so a server stops before its state dir goes. */
export function onCleanup(fn: () => void | Promise<void>) {
  pending.push(fn);
}

export async function runCleanups() {
  for (const fn of pending.splice(0).reverse()) await fn();
}
