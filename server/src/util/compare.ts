/** Orders strings by UTF-16 code unit, the same order a bare `.sort()` gives. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
