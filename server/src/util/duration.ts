import { parseDuration } from "@gangway/shared/duration";

export { parseDuration };

/** A template's `idleAfter` / `x-gangway.idle` as milliseconds; 0 means never. */
export function idleMs(text: string): number {
  if (text === "never" || text === "0") return 0;
  return parseDuration(text) ?? 0;
}
