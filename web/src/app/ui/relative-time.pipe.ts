import { Pipe, type PipeTransform } from '@angular/core';

const STEPS: [limit: number, div: number, unit: string][] = [
  [90, 1, 's'],
  [90 * 60, 60, 'min'],
  [36 * 3600, 3600, 'h'],
  [Infinity, 86_400, 'd'],
];

/** "3 h ago" / "in 5 d". Pure over (value, now): pass `clock.now()` so it re-renders when time moves. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const delta = Math.round((t - now) / 1000);
  const abs = Math.abs(delta);
  if (abs < 10) return 'just now';
  const [, div, unit] = STEPS.find(([limit]) => abs < limit)!;
  const n = Math.max(1, Math.round(abs / div));
  return delta < 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`;
}

@Pipe({ name: 'relativeTime' })
export class RelativeTimePipe implements PipeTransform {
  transform(iso: string | null | undefined, now: number): string {
    return relativeTime(iso, now);
  }
}
