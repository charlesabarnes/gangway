import { parseDuration } from "@gangway/shared/duration";

export { parseDuration };

export function idleMs(text: string): number {
  if (text === "never" || text === "0") return 0;
  return parseDuration(text) ?? 0;
}
