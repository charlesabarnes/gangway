// For a value the code guarantees but the type cannot: a lookup right after its key was set, a
// regex group that always matches. It fails with a message where `!` would fail later, elsewhere.
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}
