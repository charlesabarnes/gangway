import { must } from "./must.ts";

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(input: string): number | null {
  const m = /^(\d{1,6})([smhdw])$/.exec(input.trim());
  if (!m) {
    return null;
  }
  const ms = Number(m[1]) * must(UNIT_MS[must(m[2], "a unit")], "a unit's length");
  return ms > 0 ? ms : null;
}
